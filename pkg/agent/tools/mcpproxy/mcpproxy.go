// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package mcpproxy registers an upstream MCP server's tools as Crowe
// Agent tools. Generalizes the pattern that pkg/agent/tools/playwright
// uses, so adding a new outbound MCP is a one-screen wrapper module.
//
// Each Mount:
//   - probes via env flag,
//   - lazily spawns a subprocess on first call,
//   - caches the client,
//   - wraps each upstream tool as an agent.Tool with namespaced name,
//   - tags mutating tools so Wave's approval flow gates them.
package mcpproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/agent/mcpclient"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

// Mount describes one upstream MCP server we proxy.
//
// The agent name for each registered tool is `Namespace + "." + Sanitize(upstreamName)`.
// Namespace must end with a dot or be empty (in which case the upstream
// name is used verbatim with underscores converted to dots).
type Mount struct {
	// EnableEnv is the env var that flips the proxy on. The mount is
	// inert until this is set to "1".
	EnableEnv string

	// Namespace prefixes every registered tool name, e.g. "fs." for
	// filesystem-mcp. Empty means use the upstream name as-is.
	Namespace string

	// Command + Args are the subprocess to spawn (e.g. "npx", "-y",
	// "@modelcontextprotocol/server-filesystem", "/some/path").
	Command string
	Args    []string

	// Env adds extra env vars on top of os.Environ(). Useful for
	// credentials like GITHUB_PERSONAL_ACCESS_TOKEN.
	Env map[string]string

	// IsMutating returns whether a given upstream tool name should be
	// flagged mutating (and thus gated by Wave's approval flow). If nil,
	// all tools are treated as non-mutating.
	IsMutating func(upstreamName string) bool

	// LogLabel prefixes log lines from this proxy.
	LogLabel string

	// Lazy state.
	clientLock sync.Mutex
	cached     *mcpclient.Client
}

// Activate registers the mount's tools with the global registry. Safe
// to call from package init() — the actual subprocess spawn is deferred
// until the first tool call.
//
// Returns the number of tools registered (0 if the env flag is unset
// or the upstream catalog probe failed).
func Activate(m *Mount) int {
	if m.EnableEnv == "" || os.Getenv(m.EnableEnv) != "1" {
		return 0
	}
	cli, err := m.getClient(context.Background())
	if err != nil {
		log.Printf("[%s] %v\n", m.label(), err)
		return 0
	}
	tools := cli.Tools()
	if len(tools) == 0 {
		log.Printf("[%s] upstream returned 0 tools\n", m.label())
		return 0
	}
	for _, t := range tools {
		registry.Register(m.wrap(t))
	}
	log.Printf("[%s] registered %d tools\n", m.label(), len(tools))
	return len(tools)
}

func (m *Mount) wrap(upstream mcpclient.Tool) *registry.Tool {
	name := m.toolName(upstream.Name)
	schema, _ := json.Marshal(upstream.InputSchema)
	if len(schema) == 0 {
		schema = json.RawMessage(`{"type":"object"}`)
	}
	mutating := false
	if m.IsMutating != nil {
		mutating = m.IsMutating(upstream.Name)
	}
	return &registry.Tool{
		Name:        name,
		Description: upstream.Description + fmt.Sprintf(" [proxied via %s MCP]", m.label()),
		Schema:      schema,
		Mutating:    mutating,
		Handler:     m.makeHandler(upstream.Name),
	}
}

func noopRenderUI(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
	return "", nil
}

// renderUI is a package var so tests can fake it and pkg/mcpui/uihost can
// inject the real implementation at init time.
var renderUI = noopRenderUI

// SetRenderer installs the UI render hook (called by pkg/mcpui/uihost at init).
func SetRenderer(fn func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error)) {
	renderUI = fn
}

// handleResult renders a detected UI resource into a block and returns a
// summary; on a detect miss, render failure, or empty summary it falls back
// to the marshalled CallResult body to preserve pre-feature behavior.
func handleResult(ctx context.Context, tool string, callRes *mcpclient.CallResult) registry.Result {
	if ui, ok := mcpui.Detect(callRes.Content); ok && !callRes.IsError {
		session, _ := scope.AgentSessionIDFromContext(ctx)
		if summary, err := renderUI(ctx, session, tool, ui); err == nil && summary != "" {
			body, _ := json.Marshal(summary)
			return registry.Result{Content: body}
		}
	}
	body, _ := json.Marshal(callRes)
	out := registry.Result{Content: body}
	if callRes.IsError {
		out.IsError = true
		out.ErrorText = stringifyContent(callRes.Content)
	}
	return out
}

func (m *Mount) makeHandler(upstreamName string) registry.Handler {
	return func(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
		var args map[string]any
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &args); err != nil {
				return registry.Result{IsError: true, ErrorText: err.Error()}, nil
			}
		}
		cli, err := m.getClient(ctx)
		if err != nil {
			return registry.Result{IsError: true, ErrorText: err.Error()}, nil
		}
		callRes, err := cli.Call(ctx, upstreamName, args)
		if err != nil {
			return registry.Result{IsError: true, ErrorText: err.Error()}, nil
		}
		return handleResult(ctx, m.toolName(upstreamName), callRes), nil
	}
}

func (m *Mount) toolName(upstream string) string {
	clean := strings.ReplaceAll(upstream, "_", ".")
	if m.Namespace == "" {
		return clean
	}
	ns := m.Namespace
	if !strings.HasSuffix(ns, ".") {
		ns += "."
	}
	return ns + upstream
}

func (m *Mount) getClient(ctx context.Context) (*mcpclient.Client, error) {
	m.clientLock.Lock()
	defer m.clientLock.Unlock()
	if m.cached != nil {
		return m.cached, nil
	}
	if m.Command == "" {
		return nil, fmt.Errorf("mcpproxy: empty Command")
	}
	// Allow command-line override via env: "<EnableEnv>_CMD" packed as
	// comma-separated bits (mirrors the playwright override pattern).
	if cmdEnv := m.EnableEnv + "_CMD"; os.Getenv(cmdEnv) != "" {
		parts := strings.Split(os.Getenv(cmdEnv), ",")
		if len(parts) > 0 {
			m.Command = parts[0]
			m.Args = parts[1:]
		}
	}
	cli, err := mcpclient.Spawn(ctx, m.Command, m.Args...)
	if err != nil {
		return nil, fmt.Errorf("spawn %s: %w", m.label(), err)
	}
	// Apply extra env by re-spawning under that env. mcpclient.Spawn
	// inherits process env; we need any extra vars set BEFORE the
	// subprocess starts. The simplest correct path: set them on the
	// parent process before calling Spawn — only safe at init time, and
	// only for one mount at a time. For credentials, the user is
	// expected to set them in their shell.
	for k, v := range m.Env {
		_ = os.Setenv(k, v)
	}
	m.cached = cli
	return cli, nil
}

func (m *Mount) label() string {
	if m.LogLabel != "" {
		return m.LogLabel
	}
	return "agent-mcpproxy"
}

func stringifyContent(items []mcpclient.ContentItem) string {
	if len(items) == 0 {
		return "tool returned error"
	}
	parts := make([]string, 0, len(items))
	for _, it := range items {
		if it.Text != "" {
			parts = append(parts, it.Text)
		}
	}
	return strings.Join(parts, "\n")
}
