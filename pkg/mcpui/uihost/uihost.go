// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package uihost renders detected MCP-UI resources into VDOM blocks and
// bridges iframe postMessage actions back to the agent.
package uihost

import (
	"context"
	"fmt"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
	"github.com/wavetermdev/waveterm/pkg/vdom"
	"github.com/wavetermdev/waveterm/pkg/waveapp"
)

type renderer interface {
	Render(ctx context.Context, html string, onAction func(mcpui.Action)) (blockID string, err error)
}

// newRenderer is overridable in tests; default builds a waveapp-backed renderer.
var newRenderer = func(key string) renderer { return &waveappRenderer{} }

var (
	mu        sync.Mutex
	renderers = map[string]renderer{}
)

func key(session, tool string) string { return session + "\x00" + tool }

// Render renders ui into the block for (session, tool), creating it on first
// use and updating it after, then returns a summary for the agent.
func Render(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
	mu.Lock()
	k := key(session, tool)
	r, ok := renderers[k]
	if !ok {
		r = newRenderer(k)
		renderers[k] = r
	}
	mu.Unlock()

	blockID, err := r.Render(ctx, ui.HTML, func(a mcpui.Action) { Dispatch(ctx, session, a) })
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Surfaced interactive UI from %s in block %s", tool, blockID), nil
}

type waveappRenderer struct {
	once    sync.Once
	client  *waveapp.Client
	blockID string
	onAct   func(mcpui.Action)
}

func (w *waveappRenderer) Render(ctx context.Context, html string, onAction func(mcpui.Action)) (string, error) {
	w.onAct = onAction
	var initErr error
	w.once.Do(func() {
		c := waveapp.MakeClient(waveapp.AppOpts{RootComponentName: "App", TargetNewBlock: true})
		// The iframe sandbox intentionally omits allow-same-origin so untrusted
		// MCP-UI HTML cannot reach the host origin; it talks back only via postMessage.
		regErr := c.RegisterComponent("App", func(_ context.Context, _ struct{}) any {
			srcdoc, _ := c.GetAtomVal("html").(string)
			return vdom.H("iframe", map[string]any{
				"sandbox": "allow-scripts",
				"srcdoc":  srcdoc,
				"style":   "width:100%;height:100%;border:0;",
			})
		})
		if regErr != nil {
			initErr = regErr
			return
		}
		c.SetGlobalEventHandler(func(_ *waveapp.Client, ev vdom.VDomEvent) {
			if raw := eventData(ev); raw != nil {
				if a, err := mcpui.MapAction(raw); err == nil {
					w.onAct(a)
				}
			}
		})
		c.SetAtomVal("html", html)
		if err := c.CreateVDomContext(&vdom.VDomTarget{NewBlock: true}); err != nil {
			initErr = err
			return
		}
		w.client = c
		w.blockID = c.VDomContextBlockId
	})
	if initErr != nil {
		return "", initErr
	}
	w.client.SetAtomVal("html", html)
	return w.blockID, nil
}
