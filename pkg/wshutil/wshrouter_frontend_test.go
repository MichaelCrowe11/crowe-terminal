// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

type frontendProbeResult struct {
	ingress baseds.LinkId
	err     error
}

type frontendProbeServer struct {
	router  *WshRouter
	results chan frontendProbeResult
}

func (*frontendProbeServer) WshServerImpl() {}

func (server *frontendProbeServer) TestCommand(ctx context.Context, data string) error {
	err := server.router.RequireLocalFrontend(ctx)
	server.results <- frontendProbeResult{GetRpcResponseHandlerFromContext(ctx).GetIngressLinkId(), err}
	return err
}

func TestRequireLocalFrontend(t *testing.T) {
	server := &WshRpc{}
	router := &WshRouter{
		lock:     &sync.Mutex{},
		routeMap: map[string]baseds.LinkId{DefaultRoute: 1},
		linkMap:  map[baseds.LinkId]*linkMeta{1: {client: server}},
	}
	cases := []struct {
		name    string
		source  string
		meta    *linkMeta
		allowed bool
	}{
		{"tab", "tab:main", &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}, true},
		{"builder", "builder:main", &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}, true},
		{"remote spoof", "tab:main", &linkMeta{trusted: true, linkKind: LinkKind_Router}, false},
		{"proc spoof", "builder:main", &linkMeta{trusted: true, linkKind: LinkKind_Leaf}, false},
		{"untrusted", "tab:main", &linkMeta{linkKind: LinkKind_Router, localFrontend: true}, false},
		{"wrong kind", "tab:main", &linkMeta{trusted: true, linkKind: LinkKind_Leaf, localFrontend: true}, false},
		{"missing link", "tab:main", nil, false},
		{"empty source", "", &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}, false},
		{"bare tab prefix", "tab:", &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}, false},
		{"bare builder prefix", "builder:", &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}, false},
		{"proc source", "proc:main", &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}, false},
		{"remote source", "conn:remote", &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}, false},
		{"block source", "feblock:main", &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			router.linkMap[2] = tc.meta
			ctx := withRespHandler(withWshRpcContext(context.Background(), server), &RpcResponseHandler{source: tc.source, ingressLinkId: 2})
			if err := router.RequireLocalFrontend(ctx); (err == nil) != tc.allowed {
				t.Fatalf("allowed = %v, error = %v", tc.allowed, err)
			}
		})
	}
	router.linkMap[2] = &linkMeta{trusted: true, linkKind: LinkKind_Router, localFrontend: true}
	ctx := withRespHandler(withWshRpcContext(context.Background(), &WshRpc{}), &RpcResponseHandler{source: "tab:main", ingressLinkId: 2})
	if err := router.RequireLocalFrontend(ctx); err == nil {
		t.Fatal("accepted another router's RPC with colliding link IDs")
	}
	for _, ingress := range []baseds.LinkId{baseds.NoLinkId, 100} {
		ctx := withRespHandler(withWshRpcContext(context.Background(), server), &RpcResponseHandler{source: "tab:main", ingressLinkId: ingress})
		if err := router.RequireLocalFrontend(ctx); err == nil {
			t.Fatalf("accepted missing ingress %d", ingress)
		}
	}
	for _, ctx := range []context.Context{nil, context.Background(), withWshRpcContext(context.Background(), server)} {
		if err := router.RequireLocalFrontend(ctx); err == nil {
			t.Fatal("accepted missing handler context")
		}
	}
	var missingRouter *WshRouter
	if err := missingRouter.RequireLocalFrontend(context.Background()); err == nil {
		t.Fatal("accepted missing router")
	}
}

func TestLocalFrontendIngressCannotBeSpoofed(t *testing.T) {
	router := NewWshRouter()
	probe := &frontendProbeServer{router: router, results: make(chan frontendProbeResult, 1)}
	server := MakeWshRpc(wshrpc.RpcContext{}, probe, "frontend-probe")
	serverLink, err := router.RegisterTrustedLeaf(server, DefaultRoute)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		router.UnregisterLink(serverLink)
		close(server.InputCh)
	})
	frontend := MakeRpcProxy("frontend")
	frontendLink := router.RegisterLocalFrontendRouter(frontend)
	t.Cleanup(func() {
		router.UnregisterLink(frontendLink)
		close(frontend.FromRemoteCh)
	})
	if err := router.bindRoute(frontendLink, "tab:main", false); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		source   string
		kind     string
		allowed  bool
		dispatch bool
	}{
		{"frontend tab", "tab:main", "frontend", true, true},
		{"frontend builder", "builder:main", "frontend", true, true},
		{"frontend proc", "proc:main", "frontend", false, true},
		{"remote tab spoof", "tab:main", "remote", false, true},
		{"remote builder spoof", "builder:main", "remote", false, true},
		{"proc router spoof", "tab:main", "proc-router", false, true},
		{"proc leaf spoof", "tab:main", "proc-leaf", false, true},
		{"untrusted spoof", "tab:main", "untrusted", false, false},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			proxy := frontend
			link := frontendLink
			if tc.kind != "frontend" {
				proxy = MakeRpcProxy(tc.kind)
				switch tc.kind {
				case "remote", "proc-router":
					link = router.RegisterTrustedRouter(proxy)
				case "proc-leaf":
					link, err = router.RegisterTrustedLeaf(proxy, "proc:test")
					if err != nil {
						t.Fatal(err)
					}
				default:
					link = router.RegisterUntrustedLink(proxy)
				}
				t.Cleanup(func() {
					router.UnregisterLink(link)
					close(proxy.FromRemoteCh)
				})
			}
			request := RpcMessage{Command: "test", ReqId: fmt.Sprintf("probe-%d", i), Source: tc.source}
			msg, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			proxy.FromRemoteCh <- baseds.RpcInputChType{MsgBytes: msg, IngressLinkId: frontendLink}
			if tc.dispatch {
				select {
				case result := <-probe.results:
					if result.ingress != link {
						t.Fatalf("ingress = %d, want real link %d", result.ingress, link)
					}
					if (result.err == nil) != tc.allowed {
						t.Fatalf("allowed = %v, error = %v", tc.allowed, result.err)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("request did not reach handler")
				}
			}
			select {
			case response := <-proxy.ToRemoteCh:
				var rpcResponse RpcMessage
				if err := json.Unmarshal(response, &rpcResponse); err != nil {
					t.Fatal(err)
				}
				if rpcResponse.ResId != request.ReqId || (rpcResponse.Error == "") != tc.allowed {
					t.Fatalf("unexpected response: %s", response)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("no response")
			}
			if !tc.dispatch {
				select {
				case <-probe.results:
					t.Fatal("untrusted request reached handler")
				default:
				}
			}
		})
	}
	router.UnregisterLink(frontendLink)
	ctx := withRespHandler(withWshRpcContext(context.Background(), server), &RpcResponseHandler{source: "tab:main", ingressLinkId: frontendLink})
	if err := router.RequireLocalFrontend(ctx); err == nil {
		t.Fatal("accepted revoked frontend ingress")
	}
}
