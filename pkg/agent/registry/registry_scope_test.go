// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
)

func makeFakeTool(name string, called *bool) *Tool {
	return &Tool{
		Name:    name,
		Handler: func(ctx context.Context, args json.RawMessage) (Result, error) { *called = true; return Result{Content: json.RawMessage(`{"ok":true}`)}, nil },
		TargetExtractor: func(args json.RawMessage) string {
			var probe struct {
				Path string `json:"path"`
			}
			_ = json.Unmarshal(args, &probe)
			return probe.Path
		},
	}
}

func TestCallWithoutBlockIDPassesThrough(t *testing.T) {
	r := MakeRegistry()
	called := false
	r.Register(makeFakeTool("test.tool", &called))

	res, err := r.Call(context.Background(), CallRequest{Name: "test.tool"})
	if err != nil || res.IsError {
		t.Fatalf("legacy caller without ctx blockID should pass: %v err=%v", res, err)
	}
	if !called {
		t.Fatalf("handler was not invoked")
	}
}

func TestCallWithBlockIDNoGrantAsks(t *testing.T) {
	resetDefaultStoreForTests(t)
	r := MakeRegistry()
	called := false
	r.Register(makeFakeTool("test.tool", &called))

	ctx := scope.WithBlockID(context.Background(), "block-1")
	ctx = scope.WithAgentSessionID(ctx, "sess-1")

	res, err := r.Call(ctx, CallRequest{Name: "test.tool"})
	if err != nil || res.IsError {
		t.Fatalf("ask mode (no grant) should still allow + log: %v err=%v", res, err)
	}
	if !called {
		t.Fatalf("ask mode should invoke handler under v1 semantics")
	}
}

func TestCallWithBlockIDExplicitDenyBlocks(t *testing.T) {
	resetDefaultStoreForTests(t)
	r := MakeRegistry()
	called := false
	r.Register(makeFakeTool("test.tool", &called))

	scope.DefaultStore().Promote("block-1", "sess-1", "test.tool", scope.ModeDeny)

	ctx := scope.WithBlockID(context.Background(), "block-1")
	ctx = scope.WithAgentSessionID(ctx, "sess-1")

	res, err := r.Call(ctx, CallRequest{Name: "test.tool"})
	if err != nil {
		t.Fatalf("deny should produce IsError result, not Go error: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected IsError result for deny: %v", res)
	}
	if !strings.Contains(res.ErrorText, "denied") {
		t.Fatalf("expected denial reason in error text: %s", res.ErrorText)
	}
	if called {
		t.Fatalf("handler must not be invoked under deny")
	}
}

func TestCallWithAllowGrantInvokes(t *testing.T) {
	resetDefaultStoreForTests(t)
	r := MakeRegistry()
	called := false
	r.Register(makeFakeTool("test.tool", &called))

	scope.DefaultStore().Promote("block-1", "sess-1", "test.tool", scope.ModeAllow)

	ctx := scope.WithBlockID(context.Background(), "block-1")
	ctx = scope.WithAgentSessionID(ctx, "sess-1")

	res, err := r.Call(ctx, CallRequest{Name: "test.tool"})
	if err != nil || res.IsError {
		t.Fatalf("allow should pass: %v err=%v", res, err)
	}
	if !called {
		t.Fatalf("handler should run under allow")
	}
}

func TestCallTargetGlobRestricts(t *testing.T) {
	resetDefaultStoreForTests(t)
	r := MakeRegistry()
	called := false
	r.Register(makeFakeTool("test.tool", &called))

	store := scope.DefaultStore()
	store.Put(&scope.CapabilityGrant{
		BlockID:        "block-1",
		AgentSessionID: "sess-1",
		Tools:          map[string]string{"test.tool": scope.ModeAllow},
		TargetPatterns: map[string][]string{"test.tool": {"/Users/me/Projects/*"}},
	})

	ctx := scope.WithBlockID(context.Background(), "block-1")
	ctx = scope.WithAgentSessionID(ctx, "sess-1")

	matchingArgs, _ := json.Marshal(map[string]string{"path": "/Users/me/Projects/foo"})
	res, _ := r.Call(ctx, CallRequest{Name: "test.tool", Arguments: matchingArgs})
	if res.IsError {
		t.Fatalf("matching target should be allowed: %v", res)
	}
	if !called {
		t.Fatalf("handler should run when target matches")
	}

	// v1 semantics: target mismatch on an allow grant falls through to ask,
	// which logs but still invokes the handler. Phase 4b/5 will surface a
	// real prompt; for now we just confirm the call completes without a
	// hard error so legacy flows do not break during rollout.
	called = false
	nonMatchingArgs, _ := json.Marshal(map[string]string{"path": "/Users/me/Downloads/report.txt"})
	res, _ = r.Call(ctx, CallRequest{Name: "test.tool", Arguments: nonMatchingArgs})
	if res.IsError {
		t.Fatalf("v1 ask mode should allow-with-log, not error: %v", res)
	}
	if !called {
		t.Fatalf("handler should still run under ask in v1")
	}
}

func TestCallExplicitDenyBeatsAllowGrant(t *testing.T) {
	resetDefaultStoreForTests(t)
	r := MakeRegistry()
	called := false
	r.Register(makeFakeTool("test.tool", &called))

	store := scope.DefaultStore()
	store.Put(&scope.CapabilityGrant{
		BlockID:        "block-1",
		AgentSessionID: "sess-1",
		Tools:          map[string]string{"test.tool": scope.ModeDeny},
		TargetPatterns: map[string][]string{"test.tool": {"/anywhere/*"}},
	})

	ctx := scope.WithBlockID(context.Background(), "block-1")
	ctx = scope.WithAgentSessionID(ctx, "sess-1")

	args, _ := json.Marshal(map[string]string{"path": "/anywhere/foo"})
	res, _ := r.Call(ctx, CallRequest{Name: "test.tool", Arguments: args})
	if !res.IsError {
		t.Fatalf("explicit deny should hard-block even with matching target: %v", res)
	}
	if called {
		t.Fatalf("handler must not run under deny")
	}
}

func resetDefaultStoreForTests(t *testing.T) {
	t.Helper()
	store := scope.DefaultStore()
	store.Revoke("block-1", "sess-1")
	store.Revoke("block-2", "sess-1")
}
