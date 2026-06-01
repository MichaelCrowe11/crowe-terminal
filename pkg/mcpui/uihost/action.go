// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"
	"encoding/json"
	"log"

	"github.com/skratchdot/open-golang/open"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

var callTool = func(ctx context.Context, name string, args json.RawMessage) {
	if _, err := registry.Default().Call(ctx, registry.CallRequest{Name: name, Arguments: args}); err != nil {
		log.Printf("[mcpui] tool call failed name=%s: %v", name, err)
	}
}

var openLink = func(url string) { _ = open.Run(url) }

func dispatchTool(ctx context.Context, session string, a mcpui.Action) {
	ctx = scope.WithAgentSessionID(ctx, session)
	callTool(ctx, a.ToolName, a.Params)
}

func dispatchPrompt(ctx context.Context, session string, a mcpui.Action) {
	log.Printf("[mcpui] prompt action (session=%s): %s", session, a.Text)
}

func dispatchLink(ctx context.Context, a mcpui.Action) { openLink(a.URL) }

func dispatchNotify(ctx context.Context, a mcpui.Action) {
	log.Printf("[mcpui] notify: %s", a.Text)
}

func dispatchIntent(ctx context.Context, session string, a mcpui.Action) {
	log.Printf("[mcpui] intent action (session=%s): %s", session, a.Intent)
}
