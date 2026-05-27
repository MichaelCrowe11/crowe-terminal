// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

// Dispatch routes a parsed MCP-UI action to the agent.
func Dispatch(ctx context.Context, session string, a mcpui.Action) {
	switch a.Kind {
	case mcpui.ActionTool:
		dispatchTool(ctx, session, a)
	case mcpui.ActionPrompt:
		dispatchPrompt(ctx, session, a)
	case mcpui.ActionLink:
		dispatchLink(ctx, a)
	case mcpui.ActionNotify:
		dispatchNotify(ctx, a)
	}
}
