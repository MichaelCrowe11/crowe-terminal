// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/chatstore"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/crowegateway"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/openaichat"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/croweauth"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/web/sse"
)

const AccountTestModels = `{"plan":"free","default_model":"crowelm-flash","models":[{"model":"crowelm-flash","name":"Flash"}]}`
const AccountTestReply = `{"id":"reply","model":"crowelm-flash","content":"test response","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5},"tool_calls":null}`

func TestAccountConfigRejectsCredentialRedirection(t *testing.T) {
	valid := wconfig.AIModeConfigType{APIType: uctypes.APIType_CroweGateway, Endpoint: croweauth.GatewayEndpoint}
	if err := validateAccountConfig(valid); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{
		"http://api.crowelogic.com/api/gateway/chat",
		"https://api.crowelogic.com.evil.example/api/gateway/chat",
		"https://api.crowelogic.com@evil.example/api/gateway/chat",
		"https://api.crowelogic.com/api/gateway/chat?redirect=elsewhere",
		"https://api.crowelogic.com/api/gateway/chat#fragment",
		"https://api.crowelogic.com/api/gateway/chat/",
		"http://localhost:8011/v1/chat/completions",
	} {
		t.Run(endpoint, func(t *testing.T) {
			config := valid
			config.Endpoint = endpoint
			if validateAccountConfig(config) == nil {
				t.Fatal("unsafe account destination accepted")
			}
		})
	}
	for _, mutate := range []func(*wconfig.AIModeConfigType){
		func(c *wconfig.AIModeConfigType) { c.APIType = uctypes.APIType_OpenAIChat },
		func(c *wconfig.AIModeConfigType) { c.ProxyURL = "http://localhost:8000" },
		func(c *wconfig.AIModeConfigType) { c.APIToken = "fictional-key" },
		func(c *wconfig.AIModeConfigType) { c.APITokenSecretName = "CROWE_MODELS_KEY" },
	} {
		config := valid
		mutate(&config)
		if validateAccountConfig(config) == nil {
			t.Fatal("account mode accepted alternate credentials or proxy")
		}
	}
}

func TestAccountBackendDispatch(t *testing.T) {
	backend, err := GetBackendByAPIType(uctypes.APIType_CroweGateway)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := backend.(*croweAccountBackend); !ok {
		t.Fatal("account mode does not use the session-aware gateway")
	}
}

type accountTransport func(*http.Request) (*http.Response, error)

func (fn accountTransport) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func accountResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

type accountTestStore struct {
	mu      sync.Mutex
	refresh string
	deletes int
}

func (s *accountTestStore) Load(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refresh, nil
}

func (s *accountTestStore) Block(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresh = ""
	return nil
}

func (s *accountTestStore) Save(_ context.Context, refresh string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresh = refresh
	return nil
}

func (s *accountTestStore) Delete(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deletes++
	s.refresh = ""
	return nil
}

func (s *accountTestStore) snapshot() (string, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refresh, s.deletes
}

type accountFixture struct {
	manager   *croweauth.Manager
	store     *accountTestStore
	clock     atomic.Int64
	refreshes atomic.Int64
}

func makeAccountFixture(t *testing.T) *accountFixture {
	t.Helper()
	fixture := &accountFixture{store: &accountTestStore{refresh: "synthetic-refresh-initial"}}
	fixture.clock.Store(time.Now().Unix())
	fixture.manager = croweauth.MakeManager(croweauth.Dependencies{
		Store: fixture.store,
		Now:   func() time.Time { return time.Unix(fixture.clock.Load(), 0) },
		Client: &http.Client{Transport: accountTransport(func(req *http.Request) (*http.Response, error) {
			if req.URL.String() != croweauth.Issuer+"/protocol/openid-connect/token" {
				t.Errorf("unexpected auth endpoint %s", req.URL)
			}
			n := fixture.refreshes.Add(1)
			return accountResponse(200, fmt.Sprintf(`{"access_token":"synthetic-access-%d","refresh_token":"synthetic-refresh-%d","token_type":"Bearer","expires_in":120}`, n, n)), nil
		})},
	})
	return fixture
}

type accountRecorder struct{ *httptest.ResponseRecorder }

func (*accountRecorder) SetWriteDeadline(time.Time) error { return nil }

func makeAccountStep(t *testing.T, ctx context.Context) (uctypes.WaveChatOpts, *sse.SSEHandlerCh, *accountRecorder) {
	t.Helper()
	opts := uctypes.WaveChatOpts{ChatId: uuid.NewString(), Config: uctypes.AIOptsType{
		APIType: uctypes.APIType_CroweGateway, Model: crowegateway.AccountDefaultModel, Endpoint: croweauth.GatewayEndpoint,
		APIToken: "must-not-use-config-token",
	}}
	msg := &openaichat.StoredChatMessage{MessageId: uuid.NewString(), Message: openaichat.ChatRequestMessage{Role: "user", Content: "test"}}
	if err := chatstore.DefaultChatStore.PostMessage(opts.ChatId, &opts.Config, msg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { chatstore.DefaultChatStore.Delete(opts.ChatId) })
	recorder := &accountRecorder{httptest.NewRecorder()}
	handler := sse.MakeSSEHandlerCh(recorder, ctx)
	t.Cleanup(handler.Close)
	return opts, handler, recorder
}

func TestAccountGateway401ExpiresWithoutReplay(t *testing.T) {
	for _, rejectAt := range []string{"models", "chat"} {
		t.Run(rejectAt, func(t *testing.T) {
			fixture := makeAccountFixture(t)
			ctx, cancel := fixture.manager.SessionContext(context.Background())
			defer cancel()
			opts, handler, recorder := makeAccountStep(t, ctx)
			requests := 0
			backend := &croweAccountBackend{manager: fixture.manager, Backend: crowegateway.Backend{Transport: accountTransport(func(req *http.Request) (*http.Response, error) {
				requests++
				if req.Header.Get("Authorization") != "Bearer synthetic-access-1" {
					t.Fatal("did not use session token")
				}
				if req.Method == http.MethodGet && rejectAt == "chat" {
					return accountResponse(200, AccountTestModels), nil
				}
				return accountResponse(401, "synthetic-access-1 private upstream error"), nil
			})}}
			_, messages, _, err := backend.RunChatStep(ctx, handler, opts, nil)
			if !errors.Is(err, croweauth.ErrSignInRequired) || len(messages) != 0 || recorder.Body.Len() != 0 {
				t.Fatalf("unexpected rejection %v", err)
			}
			if strings.Contains(err.Error(), "synthetic-access") || opts.Config.APIToken != "must-not-use-config-token" {
				t.Fatal("leaked or mutated token")
			}
			status, statusErr := fixture.manager.Status(context.Background())
			stored, deletes := fixture.store.snapshot()
			if statusErr != nil || status.State != croweauth.StateExpired || stored != "" || deletes != 1 {
				t.Fatalf("session not expired: %+v %v", status, statusErr)
			}
			want := 1
			if rejectAt == "chat" {
				want = 2
			}
			if requests != want || fixture.refreshes.Load() != 1 {
				t.Fatal("replayed request after 401")
			}
		})
	}
}

func TestAccountNonAuthFailuresPreserveSession(t *testing.T) {
	for _, test := range []struct {
		status int
		body   string
		want   error
	}{
		{402, `{"detail":{"code":"free_daily_cap"}}`, crowegateway.ErrFreeDailyCap},
		{403, "private body", crowegateway.ErrPlan},
		{410, "private body", crowegateway.ErrModelRetired},
		{429, "private body", crowegateway.ErrRateLimit},
		{500, "private body", crowegateway.ErrGateway},
	} {
		t.Run(fmt.Sprint(test.status), func(t *testing.T) {
			fixture := makeAccountFixture(t)
			ctx, cancel := fixture.manager.SessionContext(context.Background())
			defer cancel()
			opts, handler, _ := makeAccountStep(t, ctx)
			requests := 0
			backend := &croweAccountBackend{manager: fixture.manager, Backend: crowegateway.Backend{Transport: accountTransport(func(req *http.Request) (*http.Response, error) {
				requests++
				if req.Method == http.MethodGet {
					return accountResponse(200, AccountTestModels), nil
				}
				return accountResponse(test.status, test.body), nil
			})}}
			_, _, _, err := backend.RunChatStep(ctx, handler, opts, nil)
			if !errors.Is(err, test.want) {
				t.Fatalf("wrong failure %v", err)
			}
			status, _ := fixture.manager.Status(context.Background())
			stored, deletes := fixture.store.snapshot()
			if status.State != croweauth.StateConnected || stored != "synthetic-refresh-1" || deletes != 0 || requests != 2 {
				t.Fatalf("non-auth failure altered session: %+v", status)
			}
		})
	}
}

func TestAccountEachStepRefreshesAndPreservesNativeAPIType(t *testing.T) {
	fixture := makeAccountFixture(t)
	ctx, cancel := fixture.manager.SessionContext(context.Background())
	defer cancel()
	opts, handler, recorder := makeAccountStep(t, ctx)
	step := 1
	backend := &croweAccountBackend{manager: fixture.manager, Backend: crowegateway.Backend{Transport: accountTransport(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != fmt.Sprintf("Bearer synthetic-access-%d", step) {
			t.Fatal("step did not refresh token")
		}
		if req.Method == http.MethodGet {
			return accountResponse(200, AccountTestModels), nil
		}
		return accountResponse(200, AccountTestReply), nil
	})}}
	_, messages, _, err := backend.RunChatStep(ctx, handler, opts, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range messages {
		if err := chatstore.DefaultChatStore.PostMessage(opts.ChatId, &opts.Config, msg); err != nil {
			t.Fatal(err)
		}
	}
	step = 2
	fixture.clock.Add(121)
	_, messages, _, err = backend.RunChatStep(ctx, handler, opts, &uctypes.WaveContinueResponse{ContinueFromKind: uctypes.StopKindToolUse})
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range messages {
		if err := chatstore.DefaultChatStore.PostMessage(opts.ChatId, &opts.Config, msg); err != nil {
			t.Fatal(err)
		}
	}
	handler.Close()
	chat := chatstore.DefaultChatStore.Get(opts.ChatId)
	ui, err := backend.ConvertAIChatToUIChat(*chat)
	if err != nil || ui.APIType != uctypes.APIType_CroweGateway || chat.APIType != uctypes.APIType_CroweGateway || len(ui.Messages) != 3 {
		t.Fatalf("native/UI API type not preserved: %v", err)
	}
	if fixture.refreshes.Load() != 2 || strings.Contains(recorder.Body.String(), "synthetic-access") || opts.Config.APIToken != "must-not-use-config-token" {
		t.Fatal("refresh count/token handling incorrect")
	}
}

func TestAccountStale401DoesNotRejectRefreshedToken(t *testing.T) {
	fixture := makeAccountFixture(t)
	ctx, cancel := fixture.manager.SessionContext(context.Background())
	defer cancel()
	opts, handler, _ := makeAccountStep(t, ctx)
	backend := &croweAccountBackend{manager: fixture.manager, Backend: crowegateway.Backend{Transport: accountTransport(func(req *http.Request) (*http.Response, error) {
		if req.Method == http.MethodGet {
			return accountResponse(200, AccountTestModels), nil
		}
		fixture.clock.Add(121)
		if token, err := fixture.manager.Token(ctx); err != nil || token != "synthetic-access-2" {
			t.Fatalf("refresh failed: %v", err)
		}
		return accountResponse(401, "rejected old token"), nil
	})}}
	_, _, _, err := backend.RunChatStep(ctx, handler, opts, nil)
	if !errors.Is(err, croweauth.ErrSignInRequired) {
		t.Fatalf("missing auth failure: %v", err)
	}
	status, _ := fixture.manager.Status(context.Background())
	stored, deletes := fixture.store.snapshot()
	if status.State != croweauth.StateConnected || stored != "synthetic-refresh-2" || deletes != 0 {
		t.Fatalf("stale 401 rejected new credentials: %+v", status)
	}
}

func TestAccountDisconnectFencesSuccessfulResponseAndLaterSteps(t *testing.T) {
	fixture := makeAccountFixture(t)
	ctx, cancel := fixture.manager.SessionContext(context.Background())
	defer cancel()
	opts, handler, recorder := makeAccountStep(t, ctx)
	requests := 0
	backend := &croweAccountBackend{manager: fixture.manager, Backend: crowegateway.Backend{Transport: accountTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		if req.Method == http.MethodGet {
			return accountResponse(200, AccountTestModels), nil
		}
		if _, err := fixture.manager.Disconnect(context.Background()); err != nil {
			t.Fatal(err)
		}
		<-req.Context().Done()
		return accountResponse(200, AccountTestReply), nil
	})}}
	_, messages, _, err := backend.RunChatStep(ctx, handler, opts, nil)
	if !errors.Is(err, context.Canceled) || len(messages) != 0 || recorder.Body.Len() != 0 {
		t.Fatalf("stale response escaped: %v", err)
	}
	_, _, _, err = backend.RunChatStep(ctx, handler, opts, &uctypes.WaveContinueResponse{})
	if err == nil || requests != 2 {
		t.Fatal("later step escaped disconnected session")
	}
	status, _ := fixture.manager.Status(context.Background())
	if status.State != croweauth.StateSignedOut {
		t.Fatalf("disconnect state changed: %+v", status)
	}
}
