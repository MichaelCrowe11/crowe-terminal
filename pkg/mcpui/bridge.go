// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpui

import "encoding/json"

const (
	ActionTool   = "tool"
	ActionPrompt = "prompt"
	ActionLink   = "link"
	ActionNotify = "notify"
	ActionIntent = "intent"
)

// Action is a parsed MCP-UI message from a rendered UI iframe.
type Action struct {
	Kind     string
	ToolName string
	Params   json.RawMessage
	Text     string
	URL      string
	Intent   string
}
