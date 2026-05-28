// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// HandleAction scopes the context to the originating block and dispatches an
// MCP-UI action posted by the mcpui view. Block id must be stamped here because
// the inbound wsh context does not carry it; session scoping is owned by Dispatch.
func HandleAction(ctx context.Context, data wshrpc.CommandMcpUiActionData) {
	ctx = scope.WithBlockID(ctx, data.BlockId)
	a := mcpui.Action{Kind: data.Type, ToolName: data.ToolName, Params: data.Params, URL: data.Url, Intent: data.Intent}
	switch data.Type {
	case mcpui.ActionPrompt:
		a.Text = data.Prompt
	case mcpui.ActionNotify:
		a.Text = data.Message
	}
	Dispatch(ctx, data.Session, a)
}
