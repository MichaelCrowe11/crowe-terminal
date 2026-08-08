// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package waveadapter

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"

	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/terminal"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/widget"
)

func toolNames(defs []uctypes.ToolDefinition) map[string]bool {
	names := make(map[string]bool, len(defs))
	for _, d := range defs {
		names[d.Name] = true
	}
	return names
}

// The screenshot result is a JSON envelope carrying a data URL, which this adapter
// cannot turn into image content; forwarding it would spend megabytes of context on
// base64 text. aiusechat registers an image-capable capture_screenshot of its own.
func TestScreenshotToolExcludedFromWavePath(t *testing.T) {
	names := toolNames(AppendAgentTools(nil))
	if names["widget_capture_screenshot"] {
		t.Fatal("widget.capture_screenshot must not reach the Wave chat path")
	}
	if !names["widget_focus"] {
		t.Fatal("widget.focus should still be exposed to the Wave chat path")
	}
	if !names["terminal_read_scrollback"] {
		t.Fatal("terminal.read_scrollback should still be exposed to the Wave chat path")
	}
}

func TestAppendAgentToolsPreservesExisting(t *testing.T) {
	existing := []uctypes.ToolDefinition{{Name: "already_here"}}
	if names := toolNames(AppendAgentTools(existing)); !names["already_here"] {
		t.Fatal("AppendAgentTools dropped a tool Wave had already built")
	}
}
