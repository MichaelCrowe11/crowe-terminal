// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package croweauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	Issuer          = "https://id.crowelogic.com/realms/crowe"
	ClientID        = "crowe-cli"
	GatewayEndpoint = "https://api.crowelogic.com/api/gateway/chat"
	StateSignedOut  = "signedout"
	StateStarting   = "starting"
	StatePending    = "pending"
	StateConnected  = "connected"
	StateExpired    = "expired"
	StateError      = "error"
	requestTimeout  = 20 * time.Second
)

var (
	ErrSignInRequired = errors.New("Connect your Crowe account in Hypheus to continue.")
	errStorage        = errors.New("Crowe account secure storage is unavailable")
	errRequest        = errors.New("Crowe sign-in request failed")
	errResponse       = errors.New("Crowe sign-in returned an invalid response")
	defaultOnce       sync.Once
	defaultManager    *Manager
)

type Status struct {
	State           string `json:"state"`
	UserCode        string `json:"usercode,omitempty"`
	VerificationURL string `json:"verificationurl,omitempty"`
	ExpiresAt       int64  `json:"expiresat,omitempty"`
	Message         string `json:"message,omitempty"`
}

// Block durably prevents Load from returning credentials until a successful Save.
// Save and Delete must be durable; implementations must not store plaintext tokens.
// One Manager owns a store, inside the application's existing single-server lock.
type CredentialStore interface {
	Load(context.Context) (string, error)
	Block(context.Context) error
	Save(context.Context, string) error
	Delete(context.Context) error
}

type Dependencies struct {
	Store  CredentialStore
	Client *http.Client
	Now    func() time.Time
	Wait   func(context.Context, time.Duration) error
	Random io.Reader
}

type sessionKey struct{}

type sessionBinding struct {
	manager    *Manager
	generation uint64
}

type refreshFlight struct {
	done       chan struct{}
	err        error
	generation uint64
}

type Manager struct {
	// Never hold lifecycleMu across storage or while acquiring mu. OS keyring calls
	// may block indefinitely, but they must not delay request cancellation.
	lifecycleMu        sync.Mutex
	lifecycleCancel    context.CancelFunc
	lifecycleAttempt   bool
	pendingDisconnects int
	requests           map[uint64]context.CancelFunc
	nextRequest        uint64
	mu                 sync.Mutex
	store              CredentialStore
	client             *http.Client
	now                func() time.Time
	wait               func(context.Context, time.Duration) error
	random             io.Reader
	loaded             bool
	status             Status
	generation         uint64
	session            context.Context
	cancel             context.CancelFunc
	access             string
	refresh            string
	refreshAt          time.Time
	flight             *refreshFlight
}

func Default() *Manager {
	defaultOnce.Do(func() {
		defaultManager = MakeManager(Dependencies{Store: makeOSStore(wavebase.GetWaveConfigDir())})
	})
	return defaultManager
}

func MakeManager(deps Dependencies) *Manager {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Wait == nil {
		deps.Wait = waitContext
	}
	if deps.Random == nil {
		deps.Random = rand.Reader
	}
	if deps.Store == nil {
		deps.Store = makeOSStore("")
	}
	transport := http.DefaultTransport
	if deps.Client != nil && deps.Client.Transport != nil {
		transport = deps.Client.Transport
	}
	session, cancel := context.WithCancel(context.Background())
	return &Manager{
		store: deps.Store, now: deps.Now, wait: deps.Wait, random: deps.Random,
		client: &http.Client{Transport: transport, Timeout: requestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return errRequest }},
		status: Status{State: StateSignedOut}, session: session, cancel: cancel, lifecycleCancel: cancel,
		requests: make(map[uint64]context.CancelFunc),
	}
}

func IsGatewayEndpoint(endpoint string) bool {
	return endpoint == GatewayEndpoint
}

// Acquire this before Token and use it for the entire gateway request/stream.
// Disconnect cancels it; cancellation cannot undo work already accepted remotely.
func (m *Manager) SessionContext(ctx context.Context) (context.Context, context.CancelFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	bound := context.WithValue(ctx, sessionKey{}, sessionBinding{manager: m, generation: m.generation})
	result, cancel := context.WithCancel(bound)
	m.nextRequest++
	id := m.nextRequest
	m.requests[id] = cancel
	if m.session.Err() != nil || m.pendingDisconnects > 0 {
		cancel()
	}
	stop := context.AfterFunc(result, func() { m.releaseRequest(id) })
	return result, func() { stop(); m.releaseRequest(id) }
}

func (m *Manager) releaseRequest(id uint64) {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	if cancel := m.requests[id]; cancel != nil {
		cancel()
		delete(m.requests, id)
	}
}

func (m *Manager) cancelRequestsLocked() {
	for id, cancel := range m.requests {
		cancel()
		delete(m.requests, id)
	}
}

func (m *Manager) loadLocked(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if m.loaded {
		return nil
	}
	refresh, err := m.store.Load(ctx)
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	if m.pendingDisconnects > 0 || m.session.Err() != nil {
		return ErrSignInRequired
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		m.status = Status{State: StateError, Message: errStorage.Error()}
		return errStorage
	}
	m.loaded = true
	m.refresh = refresh
	if refresh != "" {
		m.status = Status{State: StateConnected}
	}
	return nil
}

func (m *Manager) Status(ctx context.Context) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	err := m.loadLocked(ctx)
	return m.status, err
}

func (m *Manager) advanceLocked() {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	m.cancel()
	m.cancelRequestsLocked()
	m.generation++
	m.session, m.cancel = context.WithCancel(context.Background())
	m.lifecycleCancel = m.cancel
	m.lifecycleAttempt = false
	if m.pendingDisconnects > 0 {
		m.cancel()
	}
	m.access, m.refresh = "", ""
	m.refreshAt = time.Time{}
	m.flight = nil
}

func (m *Manager) beginAttemptCancel() bool {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	if !m.lifecycleAttempt {
		return false
	}
	m.lifecycleAttempt = false
	m.pendingDisconnects++
	m.lifecycleCancel()
	m.cancelRequestsLocked()
	return true
}

func (m *Manager) beginDisconnect() {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	m.pendingDisconnects++
	m.lifecycleCancel()
	m.cancelRequestsLocked()
}

func (m *Manager) endDisconnectLocked() {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	m.pendingDisconnects--
	if m.pendingDisconnects == 0 {
		m.session, m.cancel = context.WithCancel(context.Background())
		m.lifecycleCancel = m.cancel
	}
}

func (m *Manager) prepareStart(ctx context.Context) (Status, uint64, context.Context, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.loadLocked(ctx); err != nil {
		return m.status, 0, nil, "", err
	}
	if m.status.State == StateStarting || m.status.State == StatePending || m.status.State == StateConnected {
		return m.status, 0, nil, "", nil
	}
	buf := make([]byte, 32)
	if _, err := io.ReadFull(m.random, buf); err != nil {
		m.status = Status{State: StateError, Message: errRequest.Error()}
		return m.status, 0, nil, "", errRequest
	}
	m.advanceLocked()
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	if m.pendingDisconnects > 0 || m.session.Err() != nil {
		return m.status, 0, nil, "", context.Canceled
	}
	m.lifecycleAttempt = true
	m.status = Status{State: StateStarting}
	return m.status, m.generation, m.session, base64.RawURLEncoding.EncodeToString(buf), nil
}

func (m *Manager) Start(ctx context.Context) (Status, error) {
	status, generation, session, verifier, err := m.prepareStart(ctx)
	if err != nil || session == nil {
		return status, err
	}
	requestCtx, cancel := context.WithCancel(session)
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	defer cancel()
	if ctx.Err() != nil {
		cancel()
	}
	challenge := sha256.Sum256([]byte(verifier))
	var result deviceResponse
	err = m.post(requestCtx, "/auth/device", url.Values{
		"client_id": {ClientID}, "scope": {"openid offline_access"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"},
	}, &result)
	if requestCtx.Err() != nil {
		err = requestCtx.Err()
	}
	if err == nil && !validDevice(result) {
		err = errResponse
	}
	return m.finishStart(generation, result, verifier, err)
}

func (m *Manager) finishStart(generation uint64, result deviceResponse, verifier string, err error) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	if m.generation != generation || m.session.Err() != nil || m.pendingDisconnects > 0 {
		return m.status, context.Canceled
	}
	if err != nil {
		m.lifecycleAttempt = false
		m.status = Status{State: StateError, Message: safeError(err).Error()}
		return m.status, safeError(err)
	}
	deadline := m.now().Add(time.Duration(result.ExpiresIn) * time.Second)
	m.status = Status{State: StatePending, UserCode: result.UserCode, VerificationURL: result.VerificationURI, ExpiresAt: deadline.UnixMilli()}
	pollCtx, cancel := context.WithTimeout(m.session, time.Duration(result.ExpiresIn)*time.Second)
	go func() {
		defer cancel()
		m.poll(pollCtx, generation, result, verifier, deadline)
	}()
	return m.status, nil
}

func (m *Manager) Cancel(ctx context.Context) (Status, error) {
	if ctx.Err() != nil {
		return Status{}, ctx.Err()
	}
	accepted := m.beginAttemptCancel()
	m.mu.Lock()
	defer m.mu.Unlock()
	if !accepted {
		return m.status, nil
	}
	defer m.endDisconnectLocked()
	m.advanceLocked()
	m.loaded = true
	m.status = Status{State: StateSignedOut}
	// A pending OS write may have finished after cancellation; delete it in order.
	if err := m.store.Delete(context.WithoutCancel(ctx)); err != nil {
		m.status.Message = "Sign-in canceled; secure credential cleanup failed. Disconnection may not survive an app restart."
		return m.status, errStorage
	}
	return m.status, nil
}

func (m *Manager) Disconnect(ctx context.Context) (Status, error) {
	m.beginDisconnect()
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.endDisconnectLocked()
	m.advanceLocked()
	m.loaded = true
	m.status = Status{State: StateSignedOut}
	// Once requested, local disconnection must persist even if the RPC caller leaves.
	if err := m.store.Delete(context.WithoutCancel(ctx)); err != nil {
		m.status.Message = "Disconnected locally; secure credential cleanup failed. Disconnection may not survive an app restart."
		return m.status, errStorage
	}
	return m.status, nil
}

// RejectToken invalidates only the session that supplied a rejected bearer token.
// The gateway must not retry a billable request after an authentication failure.
func (m *Manager) RejectToken(ctx context.Context, rejectedToken string) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	binding, bound := ctx.Value(sessionKey{}).(sessionBinding)
	if rejectedToken == "" || rejectedToken != m.access || !bound || binding.manager != m || binding.generation != m.generation {
		return m.status, nil
	}
	m.advanceLocked()
	m.loaded = true
	m.status = Status{State: StateExpired, Message: ErrSignInRequired.Error()}
	if err := m.store.Delete(context.WithoutCancel(ctx)); err != nil {
		m.status.Message = "Crowe session expired; secure credential cleanup failed. Disconnection may not survive an app restart."
		return m.status, errStorage
	}
	return m.status, nil
}

func (m *Manager) Token(ctx context.Context) (string, error) {
	token, flight, err := m.tokenOrFlight(ctx)
	if err != nil || token != "" {
		return token, err
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-flight.done:
		return m.tokenAfterFlight(ctx, flight)
	}
}

func (m *Manager) tokenAfterFlight(ctx context.Context, flight *refreshFlight) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if flight.generation != m.generation {
		return "", ErrSignInRequired
	}
	if flight.err != nil {
		return "", flight.err
	}
	if m.access == "" || !m.now().Before(m.refreshAt) {
		return "", ErrSignInRequired
	}
	return m.deliverTokenLocked(ctx)
}

func (m *Manager) deliverTokenLocked(ctx context.Context) (string, error) {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if m.pendingDisconnects > 0 || m.session.Err() != nil {
		return "", ErrSignInRequired
	}
	return m.access, nil
}

func (m *Manager) tokenOrFlight(ctx context.Context) (string, *refreshFlight, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if binding, ok := ctx.Value(sessionKey{}).(sessionBinding); ok && (binding.manager != m || binding.generation != m.generation) {
		return "", nil, ErrSignInRequired
	}
	if err := m.loadLocked(ctx); err != nil {
		return "", nil, err
	}
	if m.access != "" && m.now().Before(m.refreshAt) {
		token, err := m.deliverTokenLocked(ctx)
		return token, nil, err
	}
	if m.session.Err() != nil {
		return "", nil, ErrSignInRequired
	}
	if m.refresh == "" {
		return "", nil, ErrSignInRequired
	}
	if m.flight != nil {
		return "", m.flight, nil
	}
	// A crash or lost response after server-side rotation must never reuse the old token.
	if err := m.store.Block(m.session); err != nil {
		m.invalidateLocked(errStorage)
		return "", nil, errStorage
	}
	if m.session.Err() != nil {
		return "", nil, ErrSignInRequired
	}
	flight := &refreshFlight{done: make(chan struct{}), generation: m.generation}
	m.flight = flight
	generation, refresh := m.generation, m.refresh
	refreshCtx, cancel := context.WithTimeout(m.session, requestTimeout)
	go func() {
		defer cancel()
		var result tokenResponse
		err := m.post(refreshCtx, "/token", url.Values{
			"grant_type": {"refresh_token"}, "client_id": {ClientID}, "refresh_token": {refresh},
		}, &result)
		if refreshCtx.Err() != nil {
			err = refreshCtx.Err()
		}
		m.finishRefresh(generation, flight, refresh, result, err)
	}()
	return "", flight, nil
}

func (m *Manager) invalidateLocked(err error) {
	m.advanceLocked()
	m.status = Status{State: StateError, Message: safeError(err).Error()}
}

func (m *Manager) finishRefresh(generation uint64, flight *refreshFlight, previous string, result tokenResponse, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	defer close(flight.done)
	if generation != m.generation {
		flight.err = ErrSignInRequired
		return
	}
	m.flight = nil
	if err == nil {
		if result.RefreshToken == "" {
			result.RefreshToken = previous
		}
		err = m.commitLocked(result)
	}
	if err != nil {
		m.invalidateLocked(err)
		flight.err = safeError(err)
	}
}

func (m *Manager) commitLocked(result tokenResponse) error {
	if !validToken(result) {
		return errResponse
	}
	lifetime := time.Duration(result.ExpiresIn) * time.Second
	expires := m.now().Add(lifetime)
	if m.session.Err() != nil {
		return ErrSignInRequired
	}
	if err := m.store.Save(m.session, result.RefreshToken); err != nil {
		return errStorage
	}
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	if m.pendingDisconnects > 0 || m.session.Err() != nil {
		return ErrSignInRequired
	}
	skew := min(30*time.Second, lifetime/10)
	m.access, m.refresh, m.refreshAt = result.AccessToken, result.RefreshToken, expires.Add(-skew)
	m.lifecycleAttempt = false
	m.status = Status{State: StateConnected, ExpiresAt: expires.UnixMilli()}
	return nil
}

func (m *Manager) finishPoll(generation uint64, result tokenResponse, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if generation != m.generation {
		return
	}
	if err == nil {
		err = m.commitLocked(result)
	}
	if err == nil {
		return
	}
	m.invalidateLocked(err)
	if errors.Is(err, context.DeadlineExceeded) || isOAuthError(err, "expired_token") {
		m.status = Status{State: StateExpired, Message: "Sign-in expired. Please try again."}
	}
}

func (m *Manager) poll(ctx context.Context, generation uint64, device deviceResponse, verifier string, deadline time.Time) {
	interval := time.Duration(device.Interval) * time.Second
	if interval == 0 {
		interval = 5 * time.Second
	}
	for {
		remaining := deadline.Sub(m.now())
		if remaining <= 0 {
			m.finishPoll(generation, tokenResponse{}, context.DeadlineExceeded)
			return
		}
		if err := m.wait(ctx, min(interval, remaining)); err != nil {
			m.finishPoll(generation, tokenResponse{}, err)
			return
		}
		if !m.now().Before(deadline) {
			m.finishPoll(generation, tokenResponse{}, context.DeadlineExceeded)
			return
		}
		var result tokenResponse
		err := m.post(ctx, "/token", url.Values{
			"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"},
			"client_id":  {ClientID}, "device_code": {device.DeviceCode}, "code_verifier": {verifier},
		}, &result)
		if ctx.Err() != nil || !m.now().Before(deadline) {
			m.finishPoll(generation, tokenResponse{}, context.DeadlineExceeded)
			return
		}
		if isOAuthError(err, "authorization_pending") {
			continue
		}
		if isOAuthError(err, "slow_down") {
			interval += 5 * time.Second
			continue
		}
		m.finishPoll(generation, result, err)
		return
	}
}

func waitContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
