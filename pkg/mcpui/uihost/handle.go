// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"
	"encoding/json"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

// HandleAction is the server-facing entrypoint for an MCP-UI action posted by
// the mcpui view. It scopes the context to the originating block + session so
// re-entered tool calls inherit the agent's grants, then dispatches.
func HandleAction(ctx context.Context, blockID, session, typ, toolName string, params json.RawMessage, promptText, url, intent, message string) {
	ctx = scope.WithBlockID(ctx, blockID)
	ctx = scope.WithAgentSessionID(ctx, session)
	a := mcpui.Action{Kind: typ, ToolName: toolName, Params: params, URL: url, Intent: intent}
	switch typ {
	case mcpui.ActionPrompt:
		a.Text = promptText
	case mcpui.ActionNotify:
		a.Text = message
	}
	Dispatch(ctx, session, a)
}
