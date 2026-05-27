// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

func dispatchTool(ctx context.Context, session string, a mcpui.Action)   {}
func dispatchPrompt(ctx context.Context, session string, a mcpui.Action) {}
func dispatchLink(ctx context.Context, a mcpui.Action)                   {}
func dispatchNotify(ctx context.Context, a mcpui.Action)                 {}
