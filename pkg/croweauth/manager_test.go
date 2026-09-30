// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package croweauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeStore struct {
	mu         sync.Mutex
	token      string
	blocked    bool
	failSave   bool
	failBlock  bool
	failDelete bool
	saves      int
	blocks     int
}

func (s *fakeStore) Load(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.blocked {
		return "", nil
	}
	return s.token, nil
}

func (s *fakeStore) Block(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failBlock {
		return errors.New("fake-storage-secret")
	}
	s.blocked = true
	s.blocks++
	return nil
}

func (s *fakeStore) Save(_ context.Context, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blocked = true
	if s.failSave {
		return errors.New("fake-storage-secret")
	}
	s.token, s.blocked = token, false
	s.saves++
	return nil
}

func (s *fakeStore) Delete(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blocked = true
	if s.failDelete {
		return errors.New("fake-storage-secret")
	}
	s.token = ""
	return nil
}

type fakeTransport func(*http.Request) (*http.Response, error)

func (f fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

const deviceBody = `{"device_code":"fake-device-secret","user_code":"ABCD-EFGH","verification_uri":"https://id.crowelogic.com/realms/crowe/device","expires_in":600,"interval":5}`
const tokenBody = `{"access_token":"fake-access-secret","refresh_token":"fake-refresh-rotated","token_type":"Bearer","expires_in":300}`

func testManager(store *fakeStore, transport fakeTransport) *Manager {
	return MakeManager(Dependencies{Store: store, Client: &http.Client{Transport: transport}, Wait: func(ctx context.Context, _ time.Duration) error { return ctx.Err() }})
}

func waitSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for worker")
	}
}

func waitState(t *testing.T, m *Manager, state string) Status {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status, err := m.Status(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if status.State == state {
			return status
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("state did not become %s", state)
	return Status{}
}

func TestDeviceFlowPKCEAndSecretOmission(t *testing.T) {
	store := &fakeStore{}
	var challenge string
	m := testManager(store, func(r *http.Request) (*http.Response, error) {
		if !strings.HasPrefix(r.URL.String(), Issuer+"/protocol/openid-connect/") {
			t.Error("wrong issuer")
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Form.Get("client_id") != ClientID {
			t.Error("wrong client")
		}
		if strings.HasSuffix(r.URL.Path, "/auth/device") {
			challenge = r.Form.Get("code_challenge")
			if r.Form.Get("code_challenge_method") != "S256" || r.Form.Get("scope") != "openid offline_access" {
				t.Error("missing PKCE/scope")
			}
			return response(200, deviceBody), nil
		}
		verifier := r.Form.Get("code_verifier")
		digest := sha256.Sum256([]byte(verifier))
		if len(verifier) != 43 || challenge != base64.RawURLEncoding.EncodeToString(digest[:]) {
			t.Error("PKCE mismatch")
		}
		if r.Form.Get("device_code") != "fake-device-secret" {
			t.Error("missing device code")
		}
		return response(200, tokenBody), nil
	})
	pending, err := m.Start(context.Background())
	if err != nil || pending.State != StatePending {
		t.Fatalf("start: %v %v", pending, err)
	}
	connected := waitState(t, m, StateConnected)
	for _, status := range []Status{pending, connected} {
		data, _ := json.Marshal(status)
		for _, forbidden := range []string{"fake-device-secret", "fake-access-secret", "fake-refresh-rotated", "device_code", "verifier", "token"} {
			if strings.Contains(string(data), forbidden) {
				t.Errorf("public status contains %s", forbidden)
			}
		}
	}
	token, err := m.Token(context.Background())
	if err != nil || token != "fake-access-secret" {
		t.Fatal("missing access token")
	}
}

func TestLatePollSuccessAfterCancel(t *testing.T) {
	entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	store := &fakeStore{}
	m := testManager(store, func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/auth/device") {
			return response(200, deviceBody), nil
		}
		close(entered)
		<-release
		defer close(returned)
		return response(200, tokenBody), nil
	})
	if _, err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitSignal(t, entered)
	if status, err := m.Cancel(context.Background()); err != nil || status.State != StateSignedOut {
		t.Fatal("cancel failed")
	}
	close(release)
	waitSignal(t, returned)
	time.Sleep(10 * time.Millisecond)
	waitState(t, m, StateSignedOut)
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.saves != 0 {
		t.Fatal("canceled poll persisted credentials")
	}
}

func TestLateStartAfterCancel(t *testing.T) {
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	m := testManager(&fakeStore{}, func(*http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return response(200, deviceBody), nil
	})
	go func() { defer close(done); _, _ = m.Start(context.Background()) }()
	waitSignal(t, entered)
	_, _ = m.Cancel(context.Background())
	close(release)
	waitSignal(t, done)
	waitState(t, m, StateSignedOut)
}

func TestConcurrentRefreshSingleflight(t *testing.T) {
	store := &fakeStore{token: "fake-refresh-original"}
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	m := testManager(store, func(r *http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		_ = r.ParseForm()
		if r.Form.Get("refresh_token") != "fake-refresh-original" {
			t.Error("wrong refresh token")
		}
		store.mu.Lock()
		blocked := store.blocked
		store.mu.Unlock()
		if !blocked {
			t.Error("refresh lacks durable write-ahead barrier")
		}
		<-release
		return response(200, tokenBody), nil
	})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, err := m.Token(context.Background())
			if err != nil || token != "fake-access-secret" {
				t.Error("refresh did not return token")
			}
		}()
	}
	waitSignal(t, entered)
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("refresh requests: %d", calls.Load())
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.saves != 1 || store.token != "fake-refresh-rotated" || store.blocked {
		t.Fatal("rotation not persisted")
	}
}

func TestLateRefreshAfterDisconnect(t *testing.T) {
	store := &fakeStore{token: "fake-refresh-original"}
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	m := testManager(store, func(*http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return response(200, tokenBody), nil
	})
	session, cancel := m.SessionContext(context.Background())
	defer cancel()
	go func() {
		defer close(done)
		if token, err := m.Token(context.Background()); token != "" || !errors.Is(err, ErrSignInRequired) {
			t.Error("late refresh returned credentials")
		}
	}()
	waitSignal(t, entered)
	if _, err := m.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitSignal(t, session.Done())
	close(release)
	waitSignal(t, done)
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.saves != 0 || !store.blocked || store.token != "" {
		t.Fatal("disconnected credentials resurrected")
	}
}

func TestRefreshSaveFailureRequiresSignIn(t *testing.T) {
	store := &fakeStore{token: "fake-refresh-original", failSave: true}
	m := testManager(store, func(*http.Request) (*http.Response, error) { return response(200, tokenBody), nil })
	if token, err := m.Token(context.Background()); token != "" || err == nil {
		t.Fatal("storage failure published access")
	}
	if _, err := m.Token(context.Background()); !errors.Is(err, ErrSignInRequired) {
		t.Fatal("failed rotation was retried")
	}
	restarted := testManager(store, func(*http.Request) (*http.Response, error) {
		t.Error("must not reuse old refresh")
		return nil, errRequest
	})
	if _, err := restarted.Token(context.Background()); !errors.Is(err, ErrSignInRequired) {
		t.Fatal("crash barrier missing")
	}
}

func TestRefreshRetainsUnrotatedToken(t *testing.T) {
	store := &fakeStore{token: "fake-refresh-original"}
	m := testManager(store, func(*http.Request) (*http.Response, error) {
		return response(200, `{"access_token":"fake-access-secret","token_type":"Bearer","expires_in":300}`), nil
	})
	if _, err := m.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.token != "fake-refresh-original" || store.blocked {
		t.Fatal("omitted refresh token mishandled")
	}
}

func TestRefreshWaiterCancellation(t *testing.T) {
	store := &fakeStore{token: "fake-refresh-original"}
	entered, release := make(chan struct{}), make(chan struct{})
	m := testManager(store, func(*http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return response(200, tokenBody), nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := m.Token(ctx); !errors.Is(err, context.Canceled) {
			t.Error("waiter cancellation ignored")
		}
	}()
	waitSignal(t, entered)
	cancel()
	waitSignal(t, done)
	close(release)
	if token, err := m.Token(context.Background()); err != nil || token == "" {
		t.Fatal("one waiter canceled shared refresh")
	}
}

func TestSlowDownAndExpiry(t *testing.T) {
	var clockMu sync.Mutex
	now := time.Now()
	var waits []time.Duration
	var polls atomic.Int32
	m := MakeManager(Dependencies{
		Store: &fakeStore{},
		Now:   func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return now },
		Wait: func(ctx context.Context, d time.Duration) error {
			clockMu.Lock()
			defer clockMu.Unlock()
			waits = append(waits, d)
			now = now.Add(d)
			return ctx.Err()
		},
		Client: &http.Client{Transport: fakeTransport(func(r *http.Request) (*http.Response, error) {
			if strings.HasSuffix(r.URL.Path, "/auth/device") {
				return response(200, strings.Replace(deviceBody, `"expires_in":600`, `"expires_in":26`, 1)), nil
			}
			if polls.Add(1) == 1 {
				return response(400, `{"error":"slow_down"}`), nil
			}
			return response(400, `{"error":"authorization_pending"}`), nil
		})},
	})
	if _, err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	status := waitState(t, m, StateExpired)
	if status.UserCode != "" || status.VerificationURL != "" {
		t.Fatal("expired state retains device info")
	}
	clockMu.Lock()
	defer clockMu.Unlock()
	if len(waits) != 4 || waits[0] != 5*time.Second || waits[1] != 10*time.Second || waits[2] != 10*time.Second || waits[3] != time.Second {
		t.Fatalf("wrong polling schedule: %v", waits)
	}
	if polls.Load() != 3 {
		t.Fatal("poll continued at expiry")
	}
}

func TestRedirectsBoundedBodiesAndSafeErrors(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		redirect string
	}{
		{"redirect", 302, "", "https://evil.invalid/fake-secret"},
		{"oversized", 200, strings.Repeat("x", maxResponseBytes+1), ""},
		{"provider-error", 400, `{"error":"fake-access-secret","error_description":"fake-device-secret"}`, ""},
		{"malformed", 200, `{"fake-secret":`, ""},
		{"verification-url", 200, strings.Replace(deviceBody, Issuer+"/device", "https://evil.invalid/fake-secret", 1), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			m := testManager(&fakeStore{}, func(*http.Request) (*http.Response, error) {
				calls++
				r := response(tc.status, tc.body)
				if tc.redirect != "" {
					r.Header.Set("Location", tc.redirect)
				}
				return r, nil
			})
			status, err := m.Start(context.Background())
			if err == nil || status.State != StateError || calls != 1 {
				t.Fatal("unsafe response accepted")
			}
			if strings.Contains(err.Error(), "fake-") || strings.Contains(status.Message, "fake-") {
				t.Fatal("secret leaked")
			}
		})
	}
}

func TestRefreshBlockedBeforeNetwork(t *testing.T) {
	store := &fakeStore{token: "fake-refresh", failBlock: true}
	m := testManager(store, func(*http.Request) (*http.Response, error) {
		t.Error("refresh request sent without durable barrier")
		return response(200, tokenBody), nil
	})
	if token, err := m.Token(context.Background()); token != "" || err == nil {
		t.Fatal("barrier failure accepted")
	}
}

func TestStaleRefreshCannotOverwriteReconnectedSession(t *testing.T) {
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	store := &fakeStore{token: "fake-original"}
	m := testManager(store, func(r *http.Request) (*http.Response, error) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") == "refresh_token" {
			close(entered)
			<-release
			return response(200, strings.ReplaceAll(tokenBody, "fake-", "fake-old-")), nil
		}
		if strings.HasSuffix(r.URL.Path, "/auth/device") {
			return response(200, deviceBody), nil
		}
		return response(200, tokenBody), nil
	})
	oldSession, cancel := m.SessionContext(context.Background())
	defer cancel()
	go func() {
		defer close(done)
		if token, err := m.Token(context.Background()); token != "" || !errors.Is(err, ErrSignInRequired) {
			t.Error("stale waiter crossed into new session")
		}
	}()
	waitSignal(t, entered)
	if _, err := m.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, StateConnected)
	close(release)
	waitSignal(t, done)
	if token, err := m.Token(oldSession); token != "" || err == nil {
		t.Fatal("stale session context obtained new token")
	}
	if token, err := m.Token(context.Background()); err != nil || token != "fake-access-secret" {
		t.Fatal("stale refresh clobbered new session")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.token != "fake-refresh-rotated" || store.saves != 1 {
		t.Fatal("stale refresh changed durable state")
	}
}

func TestRejectTokenFencedBySessionAndToken(t *testing.T) {
	store := &fakeStore{token: "fake-refresh"}
	m := testManager(store, func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/auth/device") {
			return response(200, deviceBody), nil
		}
		return response(200, tokenBody), nil
	})
	session, cancel := m.SessionContext(context.Background())
	defer cancel()
	token, err := m.Token(session)
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []struct {
		ctx   context.Context
		token string
	}{
		{context.Background(), token}, {session, "fake-other-access"}, {session, ""},
	} {
		if status, err := m.RejectToken(candidate.ctx, candidate.token); err != nil || status.State != StateConnected {
			t.Fatal("unbound or mismatched rejection expired session")
		}
	}
	if status, err := m.RejectToken(session, token); err != nil || status.State != StateExpired {
		t.Fatal("matching rejection did not expire session")
	}
	waitSignal(t, session.Done())
	if _, err := m.Token(context.Background()); !errors.Is(err, ErrSignInRequired) {
		t.Fatal("rejected session still supplies credentials")
	}
	if _, err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, StateConnected)
	// The fake server deliberately reissues the same bearer string across generations.
	if status, err := m.RejectToken(session, token); err != nil || status.State != StateConnected {
		t.Fatal("stale rejection expired a replacement session")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.blocked || store.token != "fake-refresh-rotated" {
		t.Fatal("stale rejection altered secure storage")
	}
}

func TestRejectTokenStorageFailureSanitized(t *testing.T) {
	store := &fakeStore{token: "fake-refresh", failDelete: true}
	m := testManager(store, func(*http.Request) (*http.Response, error) { return response(200, tokenBody), nil })
	session, cancel := m.SessionContext(context.Background())
	defer cancel()
	token, err := m.Token(session)
	if err != nil {
		t.Fatal(err)
	}
	status, err := m.RejectToken(session, token)
	if err == nil || status.State != StateExpired || strings.Contains(status.Message, "fake-") || strings.Contains(err.Error(), "fake-") {
		t.Fatal("rejection did not preserve safe cleanup error")
	}
	if _, err := m.Token(context.Background()); !errors.Is(err, ErrSignInRequired) {
		t.Fatal("failed cleanup left rejected session active")
	}
}

func TestGatewayEndpointExact(t *testing.T) {
	if !IsGatewayEndpoint(GatewayEndpoint) {
		t.Fatal("fixed endpoint rejected")
	}
	for _, endpoint := range []string{"http://api.crowelogic.com/api/gateway/chat", GatewayEndpoint + "/", GatewayEndpoint + "?x=1", GatewayEndpoint + "#x", "https://api.crowelogic.com.evil.invalid/api/gateway/chat", "https://user@api.crowelogic.com/api/gateway/chat"} {
		if IsGatewayEndpoint(endpoint) {
			t.Errorf("unsafe endpoint accepted: %s", endpoint)
		}
	}
}
