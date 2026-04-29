// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package web exposes the in-window webview block as agent tools. The
// tools call into the frontend via wshrpc routed to MakeFeBlockRouteId(),
// where WebWshClient runs `webview.executeJavaScript()` and
// `webview.capturePage()` and returns the result.
//
// This is the "browse in the same window" surface — distinct from
// pkg/agent/tools/playwright which spawns a separate Playwright MCP
// process. Both register tools under browser.* but the user can tell
// them apart: in-window is browser.in_window.* (you watch it happen);
// playwright is browser.* (headless or windowed by Playwright).
package web

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	defaultTimeoutMs = 10000
	maxTimeoutMs     = 60000
	maxReadChars     = 100_000
)

func init() {
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.navigate",
		Description: "Navigate the in-window web block to a URL. Updates the block's url meta — the user sees the page load in the same Wave window.",
		Schema:      json.RawMessage(SchemaNavigate),
		Mutating:    true,
		Handler:     handleNavigate,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.read",
		Description: "Read the visible text of the page in the in-window web block. Returns visible text plus the current URL and title.",
		Schema:      json.RawMessage(SchemaRead),
		Mutating:    false,
		Handler:     handleRead,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.click",
		Description: "Click an element in the in-window web block by CSS selector. Mutating because clicks can submit forms, navigate, or trigger JS.",
		Schema:      json.RawMessage(SchemaClick),
		Mutating:    true,
		Handler:     handleClick,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.type",
		Description: "Type text into an input/textarea matched by CSS selector in the in-window web block. Fires input + change events. Optionally press Enter at the end.",
		Schema:      json.RawMessage(SchemaType),
		Mutating:    true,
		Handler:     handleType,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.screenshot",
		Description: "Capture a PNG screenshot of the in-window web block via Electron capturePage(). Returns base64 PNG.",
		Schema:      json.RawMessage(SchemaScreenshot),
		Mutating:    false,
		Handler:     handleScreenshot,
	})
	registry.Register(&registry.Tool{
		Name:        "browser.in_window.eval",
		Description: "Run arbitrary JavaScript in the in-window web block and return its result as JSON. Mutating because the script can do anything.",
		Schema:      json.RawMessage(SchemaEval),
		Mutating:    true,
		Handler:     handleEval,
	})
}

const SchemaNavigate = `{
  "type": "object",
  "properties": {
    "blockid": {"type":"string","description":"Web block id (8-char prefix or full)"},
    "url":     {"type":"string","minLength":1}
  },
  "required":["blockid","url"],
  "additionalProperties": false
}`

const SchemaRead = `{
  "type": "object",
  "properties": {
    "blockid":   {"type":"string"},
    "max_chars": {"type":"integer","minimum":100,"maximum":100000,"default":20000}
  },
  "required":["blockid"],
  "additionalProperties": false
}`

const SchemaClick = `{
  "type": "object",
  "properties": {
    "blockid":  {"type":"string"},
    "selector": {"type":"string","minLength":1,"description":"CSS selector"}
  },
  "required":["blockid","selector"],
  "additionalProperties": false
}`

const SchemaType = `{
  "type": "object",
  "properties": {
    "blockid":  {"type":"string"},
    "selector": {"type":"string","minLength":1},
    "text":     {"type":"string"},
    "press_enter": {"type":"boolean","default":false},
    "clear":      {"type":"boolean","default":true,"description":"Clear the field before typing"}
  },
  "required":["blockid","selector","text"],
  "additionalProperties": false
}`

const SchemaScreenshot = `{
  "type": "object",
  "properties": {
    "blockid": {"type":"string"}
  },
  "required":["blockid"],
  "additionalProperties": false
}`

const SchemaEval = `{
  "type": "object",
  "properties": {
    "blockid":     {"type":"string"},
    "script":      {"type":"string","minLength":1,"description":"JavaScript to evaluate. Must be a single expression or async function — return the value you want surfaced."},
    "timeout_ms":  {"type":"integer","minimum":100,"maximum":60000,"default":10000}
  },
  "required":["blockid","script"],
  "additionalProperties": false
}`

type withBlockID struct {
	BlockID string `json:"blockid"`
}

type navigateArgs struct {
	BlockID string `json:"blockid"`
	URL     string `json:"url"`
}

type readArgs struct {
	BlockID  string `json:"blockid"`
	MaxChars int    `json:"max_chars"`
}

type clickArgs struct {
	BlockID  string `json:"blockid"`
	Selector string `json:"selector"`
}

type typeArgs struct {
	BlockID    string `json:"blockid"`
	Selector   string `json:"selector"`
	Text       string `json:"text"`
	PressEnter bool   `json:"press_enter"`
	Clear      bool   `json:"clear"`
}

type evalArgs struct {
	BlockID   string `json:"blockid"`
	Script    string `json:"script"`
	TimeoutMs int    `json:"timeout_ms"`
}

func handleNavigate(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args navigateArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	blockID, err := resolveWebBlock(ctx, args.BlockID)
	if err != nil {
		return errResult(err), nil
	}
	blockORef := waveobj.MakeORef(waveobj.OType_Block, blockID)
	if err := wstore.UpdateObjectMeta(ctx, blockORef, map[string]any{"url": args.URL}, false); err != nil {
		return errResult(fmt.Errorf("set url: %w", err)), nil
	}
	// Without this, the frontend's blockAtom doesn't see the meta change
	// and the webview stays on its current URL even though wstore was updated.
	wcore.SendWaveObjUpdate(blockORef)
	body, _ := json.Marshal(map[string]any{
		"navigated": true,
		"blockid":   blockID,
		"url":       args.URL,
	})
	return registry.Result{Content: body}, nil
}

func handleRead(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args readArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	max := args.MaxChars
	if max <= 0 {
		max = 20000
	}
	if max > maxReadChars {
		max = maxReadChars
	}
	script := fmt.Sprintf(`(() => {
  const t = (document.body && document.body.innerText) || "";
  return { text: t.slice(0, %d), truncated: t.length > %d, url: location.href, title: document.title };
})()`, max, max)
	return runJS(ctx, args.BlockID, script, defaultTimeoutMs)
}

func handleClick(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args clickArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	script := fmt.Sprintf(`(() => {
  const el = document.querySelector(%s);
  if (!el) return { ok:false, reason:"selector not found" };
  el.click();
  return { ok:true, tag: el.tagName, text: (el.innerText||"").slice(0,200) };
})()`, jsString(args.Selector))
	return runJS(ctx, args.BlockID, script, defaultTimeoutMs)
}

func handleType(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args typeArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	clearLine := "true"
	if !args.Clear {
		clearLine = "false"
	}
	enterLine := "false"
	if args.PressEnter {
		enterLine = "true"
	}
	script := fmt.Sprintf(`(() => {
  const el = document.querySelector(%s);
  if (!el) return { ok:false, reason:"selector not found" };
  if (typeof el.focus === "function") el.focus();
  if (%s) { el.value = ""; el.dispatchEvent(new Event("input",{bubbles:true})); }
  el.value = (el.value||"") + %s;
  el.dispatchEvent(new Event("input",{bubbles:true}));
  el.dispatchEvent(new Event("change",{bubbles:true}));
  if (%s) {
    const ke = new KeyboardEvent("keydown", {key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true});
    el.dispatchEvent(ke);
    if (el.form && typeof el.form.submit === "function") {
      try { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); } catch(e){}
    }
  }
  return { ok:true, value: el.value };
})()`, jsString(args.Selector), clearLine, jsString(args.Text), enterLine)
	return runJS(ctx, args.BlockID, script, defaultTimeoutMs)
}

func handleScreenshot(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args withBlockID
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	blockID, err := resolveWebBlock(ctx, args.BlockID)
	if err != nil {
		return errResult(err), nil
	}
	cli := wshclient.GetBareRpcClient()
	res, err := wshclient.WebCaptureCommand(cli, wshrpc.CommandWebCaptureData{},
		&wshrpc.RpcOpts{Route: wshutil.MakeFeBlockRouteId(blockID), Timeout: 15000})
	if err != nil {
		return errResult(err), nil
	}
	body, _ := json.Marshal(map[string]any{
		"blockid":    blockID,
		"png_base64": res.PNGBase64,
		"url":        res.URL,
		"title":      res.Title,
	})
	return registry.Result{Content: body}, nil
}

func handleEval(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args evalArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	timeout := args.TimeoutMs
	if timeout <= 0 {
		timeout = defaultTimeoutMs
	}
	if timeout > maxTimeoutMs {
		timeout = maxTimeoutMs
	}
	return runJS(ctx, args.BlockID, args.Script, timeout)
}

func runJS(ctx context.Context, widgetID, script string, timeoutMs int) (registry.Result, error) {
	blockID, err := resolveWebBlock(ctx, widgetID)
	if err != nil {
		return errResult(err), nil
	}
	cli := wshclient.GetBareRpcClient()
	res, err := wshclient.WebExecuteJSCommand(cli, wshrpc.CommandWebExecuteJSData{
		Script:    script,
		TimeoutMs: timeoutMs,
	}, &wshrpc.RpcOpts{Route: wshutil.MakeFeBlockRouteId(blockID), Timeout: int64(timeoutMs + 2000)})
	if err != nil {
		return errResult(err), nil
	}
	if res.Error != "" {
		return registry.Result{IsError: true, ErrorText: res.Error}, nil
	}
	out := map[string]any{
		"blockid": blockID,
		"url":     res.URL,
		"title":   res.Title,
	}
	if res.ResultJSON != "" {
		var parsed any
		if jerr := json.Unmarshal([]byte(res.ResultJSON), &parsed); jerr == nil {
			out["result"] = parsed
		} else {
			out["result_raw"] = res.ResultJSON
		}
	}
	body, _ := json.Marshal(out)
	return registry.Result{Content: body}, nil
}

func resolveWebBlock(ctx context.Context, idOrPrefix string) (string, error) {
	if idOrPrefix == "" {
		return "", fmt.Errorf("blockid required")
	}
	// Try direct lookup first.
	if block, _ := wstore.DBGet[*waveobj.Block](ctx, idOrPrefix); block != nil {
		return assertWebView(block)
	}
	// Fall back to prefix scan among web blocks.
	all, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return "", err
	}
	for _, b := range all {
		if b == nil || b.Meta == nil {
			continue
		}
		if v, _ := b.Meta["view"].(string); v != "web" {
			continue
		}
		if strings.HasPrefix(b.OID, idOrPrefix) {
			return b.OID, nil
		}
	}
	return "", fmt.Errorf("no web block found matching %q", idOrPrefix)
}

func assertWebView(block *waveobj.Block) (string, error) {
	view, _ := block.Meta["view"].(string)
	if view != "web" {
		return "", fmt.Errorf("block %s is view=%q, expected 'web'", block.OID, view)
	}
	return block.OID, nil
}

func errResult(err error) registry.Result {
	return registry.Result{IsError: true, ErrorText: err.Error()}
}

// jsString safely embeds a Go string as a JS string literal in our
// generated scripts. We need this because we're concatenating user
// input (selector, text) into a JS source we send for evaluation.
func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// keep import in case time-based timeouts move here later.
var _ = time.Now
