// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package playwright registers Playwright MCP tools as agent tools by
// proxying through pkg/agent/mcpclient.
//
// Activation: opt-in via env var CROWE_AGENT_PLAYWRIGHT=1. The MCP
// server is launched lazily on the first call (no idle subprocess).
//
// Tool naming: each upstream Playwright tool `browser_navigate` is
// registered as agent tool `browser.navigate` (dot-separated to match
// the agent registry's convention).
package playwright

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
)

const (
	EnableEnv  = "CROWE_AGENT_PLAYWRIGHT"
	CommandEnv = "CROWE_AGENT_PLAYWRIGHT_CMD"
)

var (
	clientLock sync.Mutex
	cachedCli  *mcpclient.Client

	knownMutating = map[string]bool{
		"browser_click":       true,
		"browser_drag":        true,
		"browser_drop":        true,
		"browser_fill_form":   true,
		"browser_file_upload": true,
		"browser_hover":       true,
		"browser_navigate":    true,
		"browser_navigate_back": true,
		"browser_press_key":   true,
		"browser_select_option": true,
		"browser_type":        true,
		"browser_evaluate":    true,
		"browser_run_code":    true,
	}
)

func init() {
	if os.Getenv(EnableEnv) != "1" {
		return
	}
	if err := registerProxies(); err != nil {
		log.Printf("[agent-playwright] %v\n", err)
	}
}

func registerProxies() error {
	cli, err := getClient(context.Background())
	if err != nil {
		return fmt.Errorf("playwright mcp not available: %w", err)
	}
	tools := cli.Tools()
	if len(tools) == 0 {
		return fmt.Errorf("playwright mcp returned 0 tools")
	}
	for _, t := range tools {
		registry.Register(makeTool(t))
	}
	log.Printf("[agent-playwright] registered %d playwright tools\n", len(tools))
	return nil
}

func makeTool(upstream mcpclient.Tool) *registry.Tool {
	agentName := "browser." + strings.TrimPrefix(upstream.Name, "browser_")
	if !strings.HasPrefix(upstream.Name, "browser_") {
		agentName = "playwright." + upstream.Name
	}
	schema, _ := json.Marshal(upstream.InputSchema)
	if len(schema) == 0 {
		schema = json.RawMessage(`{"type":"object"}`)
	}
	return &registry.Tool{
		Name:        agentName,
		Description: upstream.Description + " [proxied through Playwright MCP]",
		Schema:      schema,
		Mutating:    knownMutating[upstream.Name],
		Handler:     makeHandler(upstream.Name),
	}
}

func makeHandler(upstreamName string) registry.Handler {
	return func(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
		var args map[string]any
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &args); err != nil {
				return registry.Result{IsError: true, ErrorText: err.Error()}, nil
			}
		}
		cli, err := getClient(ctx)
		if err != nil {
			return registry.Result{IsError: true, ErrorText: err.Error()}, nil
		}
		callRes, err := cli.Call(ctx, upstreamName, args)
		if err != nil {
			return registry.Result{IsError: true, ErrorText: err.Error()}, nil
		}
		body, _ := json.Marshal(callRes)
		out := registry.Result{Content: body}
		if callRes.IsError {
			out.IsError = true
			out.ErrorText = stringifyContent(callRes.Content)
		}
		return out, nil
	}
}

func getClient(ctx context.Context) (*mcpclient.Client, error) {
	clientLock.Lock()
	defer clientLock.Unlock()
	if cachedCli != nil {
		return cachedCli, nil
	}
	cmd := os.Getenv(CommandEnv)
	args := []string{"-y", "@playwright/mcp@latest"}
	if cmd == "" {
		cmd = "npx"
	} else {
		// Custom command takes raw args after a comma split, e.g.
		// CROWE_AGENT_PLAYWRIGHT_CMD="node,/abs/path/server.js"
		parts := strings.Split(cmd, ",")
		cmd = parts[0]
		args = parts[1:]
	}
	cli, err := mcpclient.Spawn(ctx, cmd, args...)
	if err != nil {
		return nil, fmt.Errorf("spawn playwright mcp: %w", err)
	}
	cachedCli = cli
	return cli, nil
}

func stringifyContent(items []mcpclient.ContentItem) string {
	if len(items) == 0 {
		return "playwright tool returned error"
	}
	parts := make([]string, 0, len(items))
	for _, it := range items {
		if it.Text != "" {
			parts = append(parts, it.Text)
		}
	}
	return strings.Join(parts, "\n")
}
