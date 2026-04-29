// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package waveadapter exposes the Crowe Agent tool registry as native
// Wave aiusechat ToolDefinitions. Wave's AI panel (frontend/app/aipanel)
// already renders tool calls with approval cards; by registering agent
// tools here, we inherit that UX for free instead of building a parallel
// renderer.
//
// This is the second leg of the "triple tool" architecture:
//
//   1. HTTP/Foundry adapter  — pkg/agent/transport/agenthttp
//   2. Wave native adapter   — this package
//   3. MCP adapter           — pkg/agent/transport/agentmcp (v1.1)
//
// Same registry, three transports. A tool registered once is available
// to CroweLM via Foundry, to OpenAI/Anthropic/Gemini via Wave's chat
// path, and to external MCP clients via the MCP server.
package waveadapter

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
)

// AppendAgentTools wraps every tool in the agent registry as a Wave
// ToolDefinition and appends to the slice Wave already built.
//
// Naming: agent tools use dotted names like "system.metrics" which are
// not always valid in OpenAI/Anthropic tool name regexes; we substitute
// underscores so "system.metrics" becomes "system_metrics" but keep the
// original in the description so the model can reason about families.
func AppendAgentTools(existing []uctypes.ToolDefinition) []uctypes.ToolDefinition {
	for _, t := range registry.Default().List() {
		def := wrap(t)
		if def != nil {
			existing = append(existing, *def)
		}
	}
	return existing
}

func wrap(t *registry.Tool) *uctypes.ToolDefinition {
	if t == nil {
		return nil
	}
	wireName := strings.ReplaceAll(t.Name, ".", "_")
	schema := schemaToMap(t.Schema)
	if schema == nil {
		schema = map[string]any{"type": "object"}
	}
	td := &uctypes.ToolDefinition{
		Name:             wireName,
		DisplayName:      t.Name,
		ToolLogName:      "agent:" + wireName,
		Description:      t.Description + nameHint(t.Name),
		ShortDescription: shortDesc(t.Name),
		InputSchema:      schema,
		ToolAnyCallback:  makeCallback(t),
		ToolCallDesc:     makeCallDesc(t),
	}
	if t.Mutating {
		td.ToolApproval = func(_ any) string { return uctypes.ApprovalNeedsApproval }
	}
	return td
}

func makeCallback(t *registry.Tool) func(any, *uctypes.UIMessageDataToolUse) (any, error) {
	return func(input any, _ *uctypes.UIMessageDataToolUse) (any, error) {
		var args json.RawMessage
		switch v := input.(type) {
		case nil:
			args = json.RawMessage(`{}`)
		case json.RawMessage:
			args = v
		default:
			b, err := json.Marshal(input)
			if err != nil {
				return nil, fmt.Errorf("agent tool %s: marshal input: %w", t.Name, err)
			}
			args = b
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		res, err := t.Handler(ctx, args)
		if err != nil && !res.IsError {
			return nil, err
		}
		if res.IsError {
			return nil, fmt.Errorf("%s", res.ErrorText)
		}
		if len(res.Content) == 0 {
			return map[string]any{"ok": true}, nil
		}
		var decoded any
		if uerr := json.Unmarshal(res.Content, &decoded); uerr != nil {
			// Tool returned non-JSON — return as raw string so the model still sees it.
			return string(res.Content), nil
		}
		return decoded, nil
	}
}

func makeCallDesc(t *registry.Tool) func(any, any, *uctypes.UIMessageDataToolUse) string {
	verb := "running"
	if t.Mutating {
		verb = "proposing"
	}
	return func(_ any, _ any, _ *uctypes.UIMessageDataToolUse) string {
		return fmt.Sprintf("%s %s", verb, t.Name)
	}
}

func schemaToMap(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}

func nameHint(toolName string) string {
	return fmt.Sprintf(" [crowe-agent tool: %s]", toolName)
}

func shortDesc(toolName string) string {
	switch {
	case strings.HasPrefix(toolName, "system."):
		return "host metrics"
	case strings.HasPrefix(toolName, "terminal."):
		return "terminal control"
	case strings.HasPrefix(toolName, "browser."):
		return "browser control"
	case strings.HasPrefix(toolName, "allowlist."):
		return "agent allowlist"
	default:
		return "agent tool"
	}
}
