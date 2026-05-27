// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
	"github.com/wavetermdev/waveterm/pkg/vdom"
)

// eventData extracts the raw postMessage JSON from a VDomEvent. Filled in Task 6.
func eventData(ev vdom.VDomEvent) []byte { return nil }

func dispatchTool(ctx context.Context, session string, a mcpui.Action)   {}
func dispatchPrompt(ctx context.Context, session string, a mcpui.Action) {}
func dispatchLink(ctx context.Context, a mcpui.Action)                   {}
func dispatchNotify(ctx context.Context, a mcpui.Action)                 {}
