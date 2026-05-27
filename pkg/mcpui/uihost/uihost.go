// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package uihost renders detected MCP-UI resources into mcpui-view blocks and
// bridges iframe postMessage actions back to the agent.
package uihost

import (
	"context"
	"fmt"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

type renderer interface {
	Render(ctx context.Context, html string) (blockID string, err error)
}

// newRenderer is overridable in tests; default builds a block-backed renderer
// that surfaces the HTML in an mcpui-view block split off the calling block.
var newRenderer = func(callingBlockID, session, tool string) renderer {
	return makeBlockRenderer(callingBlockID, session, tool)
}

var (
	mu        sync.Mutex
	renderers = map[string]renderer{}
)

func key(session, tool string) string { return session + "\x00" + tool }

// Render renders ui into the block for (session, tool), creating it on first
// use and updating it after, then returns a summary for the agent.
func Render(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
	callingBlockID, _ := scope.BlockIDFromContext(ctx)

	mu.Lock()
	k := key(session, tool)
	r, ok := renderers[k]
	if !ok {
		r = newRenderer(callingBlockID, session, tool)
		renderers[k] = r
	}
	mu.Unlock()

	blockID, err := r.Render(ctx, ui.HTML)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Surfaced interactive UI from %s in block %s", tool, blockID), nil
}
