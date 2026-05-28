// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

func TestHandleActionToolScopesAndDispatches(t *testing.T) {
	var gotName string
	var gotArgs json.RawMessage
	var gotSession, gotBlock string
	var sessionOK, blockOK bool
	prev := callTool
	callTool = func(ctx context.Context, name string, args json.RawMessage) {
		gotName, gotArgs = name, args
		gotSession, sessionOK = scope.AgentSessionIDFromContext(ctx)
		gotBlock, blockOK = scope.BlockIDFromContext(ctx)
	}
	defer func() { callTool = prev }()

	HandleAction(context.Background(), "blk-1", "sessA", mcpui.ActionTool, "fs.read", json.RawMessage(`{"path":"/x"}`), "", "", "", "")

	if gotName != "fs.read" || string(gotArgs) != `{"path":"/x"}` {
		t.Fatalf("bad tool call: %s %s", gotName, gotArgs)
	}
	if !sessionOK || gotSession != "sessA" {
		t.Fatalf("session not scoped: ok=%v val=%q", sessionOK, gotSession)
	}
	if !blockOK || gotBlock != "blk-1" {
		t.Fatalf("block not scoped: ok=%v val=%q", blockOK, gotBlock)
	}
}
