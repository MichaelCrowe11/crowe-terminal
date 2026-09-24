// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/wavetermdev/waveterm/pkg/authkey"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

type frontendProvenanceServer struct{}

func (*frontendProvenanceServer) WshServerImpl() {}

func (*frontendProvenanceServer) TestCommand(ctx context.Context, data string) error {
	return wshutil.DefaultRouter.RequireLocalFrontend(ctx)
}

func TestWebSocketFrontendRequiresSeparateCapability(t *testing.T) {
	t.Setenv("WAVETERM_AUTH_KEY", "synthetic-backend-key")
	t.Setenv("WAVETERM_FRONTEND_KEY", "synthetic-frontend-key")
	if err := authkey.SetAuthKeyFromEnv(); err != nil {
		t.Fatal(err)
	}
	previousRouter := wshutil.DefaultRouter
	router := wshutil.NewWshRouter()
	wshutil.DefaultRouter = router
	t.Cleanup(func() { wshutil.DefaultRouter = previousRouter })
	rpc := wshutil.MakeWshRpc(wshrpc.RpcContext{}, &frontendProvenanceServer{}, "frontend-provenance")
	link, err := router.RegisterTrustedLeaf(rpc, wshutil.DefaultRoute)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { router.UnregisterLink(link); close(rpc.InputCh) })
	var handlers sync.WaitGroup
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlers.Add(1)
		defer handlers.Done()
		_ = HandleWsInternal(w, r)
	}))
	defer handlers.Wait()
	defer server.Close()
	cases := []struct {
		name       string
		backendKey string
		frontend   string
		source     string
		allowed    bool
	}{
		{"generic tab spoof", "synthetic-backend-key", "", "tab:spoof", false},
		{"generic builder spoof", "synthetic-backend-key", "wrong", "builder:spoof", false},
		{"trusted tab", "synthetic-backend-key", "synthetic-frontend-key", "tab:main", true},
		{"trusted builder", "synthetic-backend-key", "synthetic-frontend-key", "builder:main", true},
		{"capability alone", "", "synthetic-frontend-key", "tab:spoof", false},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			headers := http.Header{}
			headers.Set("X-AuthKey", tc.backendKey)
			headers.Set("X-Wave-Frontend-Key", tc.frontend)
			headers.Set("Origin", "http://untrusted-preview.test")
			url := strings.Replace(server.URL, "http:", "ws:", 1) + fmt.Sprintf("/ws?stableid=synthetic-%d", i)
			conn, response, err := websocket.DefaultDialer.Dial(url, headers)
			if tc.backendKey == "" {
				if err == nil || response.StatusCode != http.StatusUnauthorized {
					t.Fatal("frontend capability bypassed backend authentication")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			request := map[string]any{"wscommand": "rpc", "message": map[string]any{"command": "test", "reqid": "test", "source": tc.source}}
			if err := conn.WriteJSON(request); err != nil {
				t.Fatal(err)
			}
			var envelope struct {
				EventType string          `json:"eventtype"`
				Data      json.RawMessage `json:"data"`
			}
			if err := conn.ReadJSON(&envelope); err != nil {
				t.Fatal(err)
			}
			var rpcResponse wshutil.RpcMessage
			if err := json.Unmarshal(envelope.Data, &rpcResponse); err != nil {
				t.Fatal(err)
			}
			if rpcResponse.ResId != "test" || (rpcResponse.Error == "") != tc.allowed {
				t.Fatalf("unexpected frontend admission: allowed=%v error=%v", tc.allowed, rpcResponse.Error)
			}
		})
	}
}
