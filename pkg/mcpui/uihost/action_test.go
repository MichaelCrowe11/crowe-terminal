package uihost

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

func TestDispatchToolReEntersRegistryWithScope(t *testing.T) {
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

	ctx := scope.WithBlockID(context.Background(), "blk-1")
	Dispatch(ctx, "sessA", mcpui.Action{Kind: mcpui.ActionTool, ToolName: "fs.read", Params: json.RawMessage(`{"path":"/x"}`)})

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

func TestDispatchLinkOpensURL(t *testing.T) {
	var opened string
	prev := openLink
	openLink = func(url string) { opened = url }
	defer func() { openLink = prev }()

	Dispatch(context.Background(), "sessA", mcpui.Action{Kind: mcpui.ActionLink, URL: "https://x.com"})
	if opened != "https://x.com" {
		t.Fatalf("link not opened: %q", opened)
	}
}

func TestDispatchUnknownAndEmptyDoNotPanic(t *testing.T) {
	Dispatch(context.Background(), "sessA", mcpui.Action{Kind: "bogus"})
	Dispatch(context.Background(), "sessA", mcpui.Action{Kind: mcpui.ActionPrompt, Text: "hi"})
	Dispatch(context.Background(), "sessA", mcpui.Action{Kind: mcpui.ActionNotify, Text: "done"})
	Dispatch(context.Background(), "sessA", mcpui.Action{Kind: mcpui.ActionIntent, Intent: "x"})
}
