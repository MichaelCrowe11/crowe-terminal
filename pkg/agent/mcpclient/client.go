// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package mcpclient is a minimal MCP (Model Context Protocol) stdio
// client. It launches an MCP server as a subprocess, performs the
// initialize handshake, lists tools, and routes tools/call requests.
//
// We use it for outbound proxies: tools registered in the agent
// registry can delegate to Playwright MCP, filesystem MCP, etc.
//
// Scope:
//   - JSON-RPC 2.0 over newline-delimited JSON on stdio
//   - initialize, tools/list, tools/call
//   - One client per server subprocess
//
// Out of scope: notifications, resources, prompts, sampling. Add when
// a proxied tool needs them.
package mcpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

const (
	jsonRPCVersion = "2.0"
	mcpVersion     = "2024-11-05"
)

type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader

	writeLock sync.Mutex
	nextID    atomic.Int64

	pendingLock sync.Mutex
	pending     map[int64]chan jsonRPCResponse

	tools     []Tool
	toolsLock sync.RWMutex

	closed atomic.Bool
}

type Tool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]any         `json:"inputSchema"`
}

type CallResult struct {
	Content []ContentItem `json:"content"`
	IsError bool          `json:"isError,omitempty"`
}

type ContentItem struct {
	Type     string            `json:"type"`
	Text     string            `json:"text,omitempty"`
	Data     string            `json:"data,omitempty"`
	Resource *EmbeddedResource `json:"resource,omitempty"`
}

type EmbeddedResource struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"` // inline text payload (e.g. HTML)
	Blob     string `json:"blob,omitempty"` // base64-encoded binary payload
}

type jsonRPCRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func Spawn(ctx context.Context, command string, args ...string) (*Client, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", command, err)
	}

	c := &Client{
		cmd:     cmd,
		stdin:   stdin,
		stdout:  bufio.NewReader(stdout),
		pending: make(map[int64]chan jsonRPCResponse),
	}
	go c.readLoop()

	if err := c.initialize(ctx); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("initialize: %w", err)
	}
	tools, err := c.fetchTools(ctx)
	if err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("tools/list: %w", err)
	}
	c.toolsLock.Lock()
	c.tools = tools
	c.toolsLock.Unlock()
	return c, nil
}

func (c *Client) Tools() []Tool {
	c.toolsLock.RLock()
	defer c.toolsLock.RUnlock()
	out := make([]Tool, len(c.tools))
	copy(out, c.tools)
	return out
}

func (c *Client) Call(ctx context.Context, name string, args map[string]any) (*CallResult, error) {
	if args == nil {
		args = map[string]any{}
	}
	resp, err := c.request(ctx, "tools/call", map[string]any{
		"name":      name,
		"arguments": args,
	})
	if err != nil {
		return nil, err
	}
	var out CallResult
	if err := json.Unmarshal(resp, &out); err != nil {
		return nil, fmt.Errorf("decode call result: %w", err)
	}
	return &out, nil
}

func (c *Client) Close() error {
	if !c.closed.CompareAndSwap(false, true) {
		return nil
	}
	_ = c.stdin.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	return c.cmd.Wait()
}

func (c *Client) initialize(ctx context.Context) error {
	_, err := c.request(ctx, "initialize", map[string]any{
		"protocolVersion": mcpVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "crowe-agent", "version": "0.1"},
	})
	if err != nil {
		return err
	}
	return c.notify(ctx, "notifications/initialized", map[string]any{})
}

func (c *Client) fetchTools(ctx context.Context) ([]Tool, error) {
	resp, err := c.request(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var wrap struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(resp, &wrap); err != nil {
		return nil, err
	}
	return wrap.Tools, nil
}

func (c *Client) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	ch := make(chan jsonRPCResponse, 1)
	c.pendingLock.Lock()
	c.pending[id] = ch
	c.pendingLock.Unlock()
	defer func() {
		c.pendingLock.Lock()
		delete(c.pending, id)
		c.pendingLock.Unlock()
	}()

	if err := c.writeMessage(jsonRPCRequest{
		JSONRPC: jsonRPCVersion,
		ID:      id,
		Method:  method,
		Params:  params,
	}); err != nil {
		return nil, err
	}

	timeout := 30 * time.Second
	if dl, ok := ctx.Deadline(); ok {
		if d := time.Until(dl); d < timeout && d > 0 {
			timeout = d
		}
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(timeout):
		return nil, fmt.Errorf("mcp request %s timed out", method)
	case resp := <-ch:
		if resp.Error != nil {
			return nil, fmt.Errorf("mcp error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	}
}

func (c *Client) notify(_ context.Context, method string, params any) error {
	return c.writeMessage(struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  any    `json:"params,omitempty"`
	}{
		JSONRPC: jsonRPCVersion,
		Method:  method,
		Params:  params,
	})
}

func (c *Client) writeMessage(payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	c.writeLock.Lock()
	defer c.writeLock.Unlock()
	if _, err := c.stdin.Write(body); err != nil {
		return err
	}
	if _, err := c.stdin.Write([]byte("\n")); err != nil {
		return err
	}
	return nil
}

func (c *Client) readLoop() {
	for {
		line, err := c.stdout.ReadBytes('\n')
		if len(line) > 0 {
			var resp jsonRPCResponse
			if jerr := json.Unmarshal(line, &resp); jerr == nil && resp.ID != 0 {
				c.pendingLock.Lock()
				ch, ok := c.pending[resp.ID]
				c.pendingLock.Unlock()
				if ok {
					ch <- resp
				}
			}
		}
		if err != nil {
			return
		}
	}
}
