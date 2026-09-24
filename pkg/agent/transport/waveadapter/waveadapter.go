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
//  1. HTTP/Foundry adapter  — pkg/agent/transport/agenthttp
//  2. Wave native adapter   — this package
//  3. MCP adapter           — pkg/agent/transport/agentmcp (v1.1)
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
	"sync"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/agent/tools/terminal"

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
// Registry tools whose results this adapter cannot represent, and which the Wave
// chat path already covers natively. widget.capture_screenshot returns its PNG as a
// data URL inside a JSON object for the external agent bridge, and this adapter has
// no way to hoist that into image content — the model would receive a multi-megabyte
// base64 string as plain text. aiusechat registers its own capture_screenshot with
// proper image-capability handling, so the registry variant is redundant here.
var waveExcludedTools = map[string]bool{
	"widget.capture_screenshot": true,
}

func AppendAgentTools(ctx context.Context, tabID string, existing []uctypes.ToolDefinition) []uctypes.ToolDefinition {
	ctx = scope.WithTabID(ctx, tabID)
	for _, t := range registry.Default().List() {
		if t != nil && waveExcludedTools[t.Name] {
			continue
		}
		def := wrap(ctx, t)
		if def != nil {
			existing = append(existing, *def)
		}
	}
	return existing
}

func wrap(ctx context.Context, t *registry.Tool) *uctypes.ToolDefinition {
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
		ToolAnyCallback:  makeCallback(ctx, t),
		ToolCallDesc:     makeCallDesc(t),
	}
	if t.Mutating {
		td.ToolApproval = func(_ any) string { return uctypes.ApprovalNeedsApproval }
	}
	if t.Name == "terminal.propose_command" {
		bindTerminalProposal(ctx, td, terminal.PrepareCommand)
	}
	return td
}

func marshalInput(input any) (json.RawMessage, error) {
	switch v := input.(type) {
	case nil:
		return json.RawMessage(`{}`), nil
	case json.RawMessage:
		return v, nil
	default:
		return json.Marshal(input)
	}
}

func makeCallback(ctx context.Context, t *registry.Tool) func(any, *uctypes.UIMessageDataToolUse) (any, error) {
	return func(input any, _ *uctypes.UIMessageDataToolUse) (any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		args, err := marshalInput(input)
		if err != nil {
			return nil, fmt.Errorf("agent tool %s: marshal input: %w", t.Name, err)
		}
		res, err := t.Handler(ctx, args)
		return decodeResult(res, err)
	}
}

func decodeResult(res registry.Result, err error) (any, error) {
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

type preparedProposal interface {
	Command() string
	BlockID() string
	TabID() string
	Connection() string
	Execute(context.Context) (registry.Result, error)
}

type proposalBinding struct {
	id       string
	proposal preparedProposal
	preview  uctypes.TerminalProposal
}

type proposalBindings struct {
	mu    sync.Mutex
	calls map[*uctypes.UIMessageDataToolUse]proposalBinding
}

func (bindings *proposalBindings) add(data *uctypes.UIMessageDataToolUse, binding proposalBinding) error {
	bindings.mu.Lock()
	defer bindings.mu.Unlock()
	for key, existing := range bindings.calls {
		if key == data || existing.id == binding.id {
			return fmt.Errorf("terminal proposal already prepared")
		}
	}
	bindings.calls[data] = binding
	return nil
}

func (bindings *proposalBindings) complete(data *uctypes.UIMessageDataToolUse, binding proposalBinding) error {
	bindings.mu.Lock()
	defer bindings.mu.Unlock()
	existing, ok := bindings.calls[data]
	if !ok || existing.id != binding.id || existing.proposal != nil {
		return fmt.Errorf("terminal proposal preparation canceled")
	}
	bindings.calls[data] = binding
	return nil
}

func (bindings *proposalBindings) take(data *uctypes.UIMessageDataToolUse) (proposalBinding, bool) {
	bindings.mu.Lock()
	defer bindings.mu.Unlock()
	binding, ok := bindings.calls[data]
	delete(bindings.calls, data)
	return binding, ok
}

func bindTerminalProposal[T preparedProposal](ctx context.Context, td *uctypes.ToolDefinition, prepare func(context.Context, json.RawMessage) (T, error)) {
	bindings := &proposalBindings{calls: make(map[*uctypes.UIMessageDataToolUse]proposalBinding)}
	td.ToolVerifyInput = func(input any, data *uctypes.UIMessageDataToolUse) error {
		if data == nil || data.ToolCallId == "" {
			return fmt.Errorf("terminal proposal requires a live tool call")
		}
		if args, ok := input.(map[string]any); ok {
			command, ok := args["command"].(string)
			if !ok {
				return fmt.Errorf("command must be a string")
			}
			if err := terminal.ValidateCommand(command); err != nil {
				return err
			}
		}
		raw, err := marshalInput(input)
		if err != nil {
			return err
		}
		if err := bindings.add(data, proposalBinding{id: data.ToolCallId}); err != nil {
			return err
		}
		proposal, err := prepare(ctx, raw)
		if err != nil {
			bindings.take(data)
			return err
		}
		preview := uctypes.TerminalProposal{
			Command: proposal.Command(), BlockId: proposal.BlockID(), TabId: proposal.TabID(), Connection: proposal.Connection(),
		}
		if err := bindings.complete(data, proposalBinding{id: data.ToolCallId, proposal: proposal, preview: preview}); err != nil {
			return err
		}
		data.TerminalProposal = &preview
		data.BlockId = preview.BlockId
		data.ToolDesc = "Type command without Enter"
		return nil
	}
	td.ToolAnyCallback = func(_ any, data *uctypes.UIMessageDataToolUse) (any, error) {
		binding, ok := bindings.take(data)
		if !ok || binding.proposal == nil || data == nil || data.ToolCallId != binding.id || data.Approval != uctypes.ApprovalUserApproved {
			return nil, fmt.Errorf("terminal proposal has no live approval")
		}
		if data.TerminalProposal == nil || *data.TerminalProposal != binding.preview {
			return nil, fmt.Errorf("terminal proposal preview changed")
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		res, err := binding.proposal.Execute(ctx)
		return decodeResult(res, err)
	}
	td.ToolCallDesc = func(_ any, output any, _ *uctypes.UIMessageDataToolUse) string {
		if output != nil {
			return "Typed command without Enter"
		}
		return "Type command without Enter"
	}
	td.ToolCallCleanup = func(data *uctypes.UIMessageDataToolUse) { bindings.take(data) }
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
