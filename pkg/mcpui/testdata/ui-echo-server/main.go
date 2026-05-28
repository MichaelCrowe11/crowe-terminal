// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Command ui-echo-server is a minimal stdio MCP server used as an e2e test
// fixture. It speaks newline-delimited JSON-RPC 2.0 (matching
// pkg/agent/mcpclient) and exposes one tool, echo_ui, that returns an
// MCP-UI ui:// HTML resource.
package main

import (
	"bufio"
	"encoding/json"
	"os"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Result  any    `json:"result"`
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	enc := json.NewEncoder(out)

	for {
		line, err := in.ReadBytes('\n')
		if len(line) > 0 {
			var req rpcRequest
			if json.Unmarshal(line, &req) == nil {
				if resp, ok := handle(req); ok {
					_ = enc.Encode(resp)
					_ = out.Flush()
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// handle answers the subset of methods mcpclient calls during Spawn + Call.
// Notifications (nil id) are acknowledged with no response.
func handle(req rpcRequest) (rpcResponse, bool) {
	if req.ID == nil {
		return rpcResponse{}, false
	}
	resp := rpcResponse{JSONRPC: "2.0", ID: *req.ID}
	switch req.Method {
	case "initialize":
		resp.Result = map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "ui-echo-server", "version": "0.1"},
		}
	case "tools/list":
		resp.Result = map[string]any{
			"tools": []map[string]any{
				{
					"name":        "echo_ui",
					"description": "Returns an MCP-UI HTML resource.",
					"inputSchema": map[string]any{"type": "object"},
				},
			},
		}
	case "tools/call":
		resp.Result = map[string]any{
			"content": []map[string]any{
				{
					"type": "resource",
					"resource": map[string]any{
						"uri":      "ui://echo/1",
						"mimeType": "text/html",
						"text":     "<button>hi</button>",
					},
				},
			},
		}
	default:
		resp.Result = map[string]any{}
	}
	return resp, true
}
