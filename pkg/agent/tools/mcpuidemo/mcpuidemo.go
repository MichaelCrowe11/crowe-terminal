// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package mcpuidemo registers a self-contained interactive MCP-UI demo so the
// maintainer can run the Task 8 manual smoke test and see the feature work.
//
// Activate: CROWE_AGENT_MCPUI_DEMO=1 (inert otherwise, like fsmcp). When
// enabled it registers two non-mutating tools: mcpui.demo.show surfaces an
// interactive widget in an mcpui block, and mcpui.demo.echo proves that
// iframe tool params arrive as a real object across the postMessage bridge.
package mcpuidemo

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
	"github.com/wavetermdev/waveterm/pkg/mcpui/uihost"
)

const (
	enableEnv = "CROWE_AGENT_MCPUI_DEMO"

	toolShow = "mcpui.demo.show"
	toolEcho = "mcpui.demo.echo"
)

func init() {
	if os.Getenv(enableEnv) != "1" {
		return
	}
	registry.Register(&registry.Tool{
		Name:        toolShow,
		Description: "Surface the interactive MCP-UI demo widget in an mcpui block.",
		Schema:      json.RawMessage(`{"type":"object"}`),
		Mutating:    false,
		Handler:     handleShow,
	})
	registry.Register(&registry.Tool{
		Name:        toolEcho,
		Description: "Echo back the params the demo widget sent, proving they arrived as a real object.",
		Schema:      json.RawMessage(`{"type":"object","properties":{"msg":{"type":"string"}}}`),
		Mutating:    false,
		Handler:     handleEcho,
	})
}

func handleShow(ctx context.Context, _ json.RawMessage) (registry.Result, error) {
	session, _ := scope.AgentSessionIDFromContext(ctx)
	summary, err := uihost.Render(ctx, session, toolShow, &mcpui.UIResource{
		URI:      "ui://demo/1",
		MimeType: "text/html",
		HTML:     demoHTML,
	})
	if err != nil {
		return registry.Result{IsError: true, ErrorText: err.Error()}, nil
	}
	return registry.Result{Content: mustJSON(summary)}, nil
}

func handleEcho(_ context.Context, args json.RawMessage) (registry.Result, error) {
	var params map[string]any
	_ = json.Unmarshal(args, &params)
	return registry.Result{Content: mustJSON(fmt.Sprintf("echo received params: %s", string(args)))}, nil
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return b
}

const demoHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP-UI Demo</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #121417;
    color: #e6e6e6;
    font-size: 13px;
  }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p.sub { margin: 0 0 14px; color: #9aa0a6; }
  .row { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; align-items: center; }
  button {
    background: #2b6cb0;
    color: #fff;
    border: 0;
    border-radius: 6px;
    padding: 7px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover { background: #3a7fc4; }
  input[type="text"] {
    flex: 1;
    min-width: 140px;
    background: #1c1f24;
    color: #e6e6e6;
    border: 1px solid #303641;
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 13px;
  }
  #log {
    margin-top: 14px;
    background: #0c0e10;
    border: 1px solid #262b33;
    border-radius: 6px;
    padding: 10px;
    height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: #b8c0cc;
  }
  .label { color: #9aa0a6; font-size: 12px; margin: 12px 0 4px; }
</style>
</head>
<body>
  <h1>MCP-UI Interactive Demo</h1>
  <p class="sub">This widget runs inside a sandboxed iframe and talks to Crowe Code over the MCP-UI postMessage bridge.</p>

  <div class="row">
    <button id="echo">Run echo tool</button>
    <button id="link">Open link</button>
    <button id="notify">Notify</button>
  </div>

  <div class="label">Send a custom message to the echo tool:</div>
  <div class="row">
    <input id="custom-input" type="text" value="custom message" />
    <button id="custom-send">Send custom</button>
  </div>

  <div class="label">Messages received from the host (look for the ack):</div>
  <div id="log"></div>

<script>
  function post(msg) {
    window.parent.postMessage(msg, "*");
  }

  function log(line) {
    var el = document.getElementById("log");
    el.textContent += line + "\n";
    el.scrollTop = el.scrollHeight;
  }

  window.addEventListener("message", function (e) {
    try {
      log("received: " + JSON.stringify(e.data));
    } catch (err) {
      log("received a message (unserializable)");
    }
  });

  window.addEventListener("load", function () {
    post({ type: "ui-lifecycle-iframe-ready" });
    log("posted ui-lifecycle-iframe-ready");
  });

  document.getElementById("echo").addEventListener("click", function () {
    post({
      type: "tool",
      payload: { toolName: "mcpui.demo.echo", params: { msg: "hello from the iframe", n: 42 } },
      messageId: "echo-1"
    });
    log("posted tool action mcpui.demo.echo (messageId echo-1)");
  });

  document.getElementById("custom-send").addEventListener("click", function () {
    var value = document.getElementById("custom-input").value;
    post({
      type: "tool",
      payload: { toolName: "mcpui.demo.echo", params: { msg: value } },
      messageId: "echo-custom"
    });
    log("posted custom tool action with msg=" + JSON.stringify(value));
  });

  document.getElementById("link").addEventListener("click", function () {
    post({ type: "link", payload: { url: "https://modelcontextprotocol.io" } });
    log("posted link action");
  });

  document.getElementById("notify").addEventListener("click", function () {
    post({ type: "notify", payload: { message: "hello from mcp-ui" } });
    log("posted notify action");
  });
</script>
</body>
</html>`
