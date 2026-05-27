// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpui

import (
	"encoding/json"
	"fmt"
)

const (
	ActionTool   = "tool"
	ActionPrompt = "prompt"
	ActionLink   = "link"
	ActionNotify = "notify"
)

// Action is a parsed MCP-UI message from a rendered UI iframe.
type Action struct {
	Kind     string
	ToolName string
	Params   json.RawMessage
	Text     string
	URL      string
}

type rawMessage struct {
	Type    string `json:"type"`
	Payload struct {
		ToolName string          `json:"toolName"`
		Params   json.RawMessage `json:"params"`
		Prompt   string          `json:"prompt"`
		URL      string          `json:"url"`
		Message  string          `json:"message"`
	} `json:"payload"`
}

// MapAction parses a raw MCP-UI postMessage body into a typed Action.
func MapAction(raw []byte) (Action, error) {
	var m rawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return Action{}, fmt.Errorf("mcpui: malformed action: %w", err)
	}
	switch m.Type {
	case ActionTool:
		return Action{Kind: ActionTool, ToolName: m.Payload.ToolName, Params: m.Payload.Params}, nil
	case ActionPrompt:
		return Action{Kind: ActionPrompt, Text: m.Payload.Prompt}, nil
	case ActionLink:
		return Action{Kind: ActionLink, URL: m.Payload.URL}, nil
	case ActionNotify:
		return Action{Kind: ActionNotify, Text: m.Payload.Message}, nil
	default:
		return Action{}, fmt.Errorf("mcpui: unknown action type %q", m.Type)
	}
}
