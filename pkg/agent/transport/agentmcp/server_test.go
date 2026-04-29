// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package agentmcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/allowlist"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/system"
	"github.com/wavetermdev/waveterm/pkg/agent/transport/agentmcp"
)

func TestMcpInitializeAndListTools(t *testing.T) {
	in := bytes.NewBufferString(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}` + "\n")
	var out bytes.Buffer
	srv := agentmcp.MakeServer(in, &out)
	_ = srv.Serve(context.Background())

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 responses, got %d:\n%s", len(lines), out.String())
	}

	var initResp map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &initResp); err != nil {
		t.Fatalf("init unmarshal: %v", err)
	}
	if initResp["error"] != nil {
		t.Fatalf("init returned error: %v", initResp["error"])
	}

	var listResp struct {
		Result struct {
			Tools []map[string]any `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &listResp); err != nil {
		t.Fatalf("list unmarshal: %v", err)
	}
	if len(listResp.Result.Tools) == 0 {
		t.Fatalf("expected non-empty tools list")
	}
	found := false
	for _, tool := range listResp.Result.Tools {
		if tool["name"] == "system.metrics" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("system.metrics not in catalog")
	}
}

func TestMcpToolsCall(t *testing.T) {
	in := bytes.NewBufferString(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"system.metrics","arguments":{"topn":1}}}` + "\n")
	var out bytes.Buffer
	srv := agentmcp.MakeServer(in, &out)
	_ = srv.Serve(context.Background())

	// MCP wraps tool output as {type:"text", text:<json-string>}, so the
	// inner JSON gets quote-escaped on the wire.
	if !strings.Contains(out.String(), `cpu_percent`) {
		t.Fatalf("expected cpu_percent in response: %s", out.String())
	}
}

func TestMcpUnknownMethod(t *testing.T) {
	in := bytes.NewBufferString(`{"jsonrpc":"2.0","id":1,"method":"nonsense","params":{}}` + "\n")
	var out bytes.Buffer
	srv := agentmcp.MakeServer(in, &out)
	_ = srv.Serve(context.Background())

	if !strings.Contains(out.String(), "method not found") {
		t.Fatalf("expected method-not-found error: %s", out.String())
	}
}
