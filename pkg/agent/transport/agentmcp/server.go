// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentmcp exposes the Crowe Agent tool registry as an MCP
// (Model Context Protocol) server over stdio. Third leg of the triple-
// tool architecture — the same tools that Foundry sees over HTTP and
// that Wave sees as native ToolDefinitions are now available to any
// MCP-aware client (Claude Desktop, Cursor, other Crowe surfaces).
//
// Wire it up in client config, e.g. Claude Desktop:
//
//   {
//     "mcpServers": {
//       "crowe-terminal": {
//         "command": "/path/to/wsh",
//         "args":    ["mcp-server"]
//       }
//     }
//   }
//
// Or run as a standalone binary: cmd/crowe-mcp launches just this
// adapter against the registry, useful for testing without wavesrv.
package agentmcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

const (
	jsonRPCVersion = "2.0"
	mcpVersion     = "2024-11-05"
)

type Server struct {
	in        io.Reader
	out       io.Writer
	writeLock sync.Mutex
}

func MakeServer(in io.Reader, out io.Writer) *Server {
	return &Server{in: in, out: out}
}

func (s *Server) Serve(ctx context.Context) error {
	scanner := bufio.NewScanner(s.in)
	scanner.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		var req rpcRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			s.writeError(0, -32700, "parse error")
			continue
		}
		s.handle(ctx, req)
	}
	return scanner.Err()
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcErrorObject `json:"error,omitempty"`
}

type rpcErrorObject struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Server) handle(ctx context.Context, req rpcRequest) {
	if len(req.ID) == 0 {
		// notification — no response
		return
	}
	switch req.Method {
	case "initialize":
		s.writeResult(req.ID, map[string]any{
			"protocolVersion": mcpVersion,
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"serverInfo": map[string]any{
				"name":    "crowe-agent",
				"version": "0.1.0",
			},
		})
	case "tools/list":
		s.writeResult(req.ID, map[string]any{"tools": s.listTools()})
	case "tools/call":
		s.handleCall(ctx, req)
	case "ping":
		s.writeResult(req.ID, map[string]any{})
	default:
		s.writeErrorWithID(req.ID, -32601, "method not found: "+req.Method)
	}
}

func (s *Server) listTools() []map[string]any {
	tools := registry.Default().List()
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		var schema any
		if len(t.Schema) > 0 {
			_ = json.Unmarshal(t.Schema, &schema)
		}
		if schema == nil {
			schema = map[string]any{"type": "object"}
		}
		out = append(out, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": schema,
		})
	}
	return out
}

func (s *Server) handleCall(ctx context.Context, req rpcRequest) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		s.writeErrorWithID(req.ID, -32602, "invalid params")
		return
	}
	res, err := registry.Default().Call(ctx, registry.CallRequest{
		Name:      params.Name,
		Arguments: params.Arguments,
	})
	if err != nil && !res.IsError {
		s.writeErrorWithID(req.ID, -32000, err.Error())
		return
	}
	if res.IsError {
		s.writeResult(req.ID, map[string]any{
			"isError": true,
			"content": []map[string]any{
				{"type": "text", "text": res.ErrorText},
			},
		})
		return
	}
	text := string(res.Content)
	if text == "" {
		text = "{}"
	}
	s.writeResult(req.ID, map[string]any{
		"content": []map[string]any{
			{"type": "text", "text": text},
		},
	})
}

func (s *Server) writeResult(id json.RawMessage, result any) {
	s.write(rpcResponse{JSONRPC: jsonRPCVersion, ID: id, Result: result})
}

func (s *Server) writeError(id int64, code int, msg string) {
	idRaw, _ := json.Marshal(id)
	s.writeErrorWithID(idRaw, code, msg)
}

func (s *Server) writeErrorWithID(id json.RawMessage, code int, msg string) {
	s.write(rpcResponse{
		JSONRPC: jsonRPCVersion,
		ID:      id,
		Error:   &rpcErrorObject{Code: code, Message: msg},
	})
}

func (s *Server) write(resp rpcResponse) {
	body, err := json.Marshal(resp)
	if err != nil {
		return
	}
	s.writeLock.Lock()
	defer s.writeLock.Unlock()
	_, _ = s.out.Write(body)
	_, _ = s.out.Write([]byte("\n"))
}

// Description satisfies a small documentation surface.
func Description() string {
	return fmt.Sprintf("Crowe Agent MCP server (protocol %s)", mcpVersion)
}
