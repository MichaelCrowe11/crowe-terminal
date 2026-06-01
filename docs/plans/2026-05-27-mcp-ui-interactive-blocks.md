# MCP-UI Interactive Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `ui://` MCP-UI resources returned by any proxied MCP server into a live, sandboxed, interactive block in Crowe Code instead of flattening them to text.

**Architecture:** A single interception point in `pkg/agent/tools/mcpproxy` inspects each tool result for an embedded UI resource (`pkg/mcpui.Detect`). On a hit, `pkg/mcpui/uihost` drives a VDOM block (via `pkg/waveapp`) that renders the server HTML in a `sandbox`ed `<iframe srcdoc>`; user interactions arrive as `message` postMessage events, get forwarded by the frontend vdom view to the backend, and are mapped to agent actions (`tool`/`prompt`/`link`/`notify`) by the uihost bridge; `tool` actions reuse Wave's existing approval flow. Any error falls back to today's text behavior.

**Tech Stack:** Go (backend, module `github.com/wavetermdev/waveterm`), `pkg/vdom` + `pkg/waveapp` (backend-driven DOM), React/TypeScript (`frontend/app/view/vdom`), `go test` and `vitest`.

---

## File Structure

**Created:**
- `pkg/mcpui/types.go`: `UIResource` type + mime constants. One responsibility: the data shape of a detected UI resource.
- `pkg/mcpui/detect.go`: `Detect([]mcpclient.ContentItem) (*UIResource, bool)`. Pure detection, no side effects.
- `pkg/mcpui/detect_test.go`: unit tests for Detect.
- `pkg/mcpui/bridge.go`: `MapAction(raw []byte) (Action, error)` parses an MCP-UI postMessage into a typed `Action`. Pure mapping, no side effects.
- `pkg/mcpui/bridge_test.go`: unit tests for MapAction.
- `pkg/mcpui/uihost/uihost.go`: `Render(ctx, session, tool, *UIResource) (summary string, err error)` owns block lifecycle + VDOM render + event handler wiring.
- `pkg/mcpui/uihost/uihost_test.go`: render-host tests using a fake waveapp client seam.

**Modified:**
- `pkg/agent/mcpclient/client.go`: extend `ContentItem` with `Resource *EmbeddedResource` and add the `EmbeddedResource` type.
- `pkg/agent/tools/mcpproxy/mcpproxy.go`: in `makeHandler`, after `cli.Call`, run `mcpui.Detect`; on hit call `uihost.Render`; on miss/error fall through to `stringifyContent`.
- `frontend/app/view/vdom/vdom-model.tsx`: forward `window` `message` events from the rendered iframe to the backend as a VDOM event.
- `frontend/app/view/vdom/vdom-utils.tsx`: allow `iframe` with `sandbox` + `srcdoc` props.

---

## Task 1: Extend ContentItem with embedded resources

**Files:**
- Modify: `pkg/agent/mcpclient/client.go:65-69`
- Test: `pkg/agent/mcpclient/client_test.go` (create if absent)

- [ ] **Step 1: Write the failing test**

Add to `pkg/agent/mcpclient/client_test.go`:

```go
package mcpclient

import (
	"encoding/json"
	"testing"
)

func TestContentItemUnmarshalEmbeddedResource(t *testing.T) {
	raw := `{"content":[{"type":"resource","resource":{"uri":"ui://widget/1","mimeType":"text/html","text":"<h1>hi</h1>"}}]}`
	var cr CallResult
	if err := json.Unmarshal([]byte(raw), &cr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(cr.Content) != 1 {
		t.Fatalf("want 1 content item, got %d", len(cr.Content))
	}
	res := cr.Content[0].Resource
	if res == nil {
		t.Fatal("resource is nil")
	}
	if res.URI != "ui://widget/1" || res.MimeType != "text/html" || res.Text != "<h1>hi</h1>" {
		t.Fatalf("bad resource: %+v", res)
	}
}

func TestContentItemBackwardCompatTextOnly(t *testing.T) {
	raw := `{"content":[{"type":"text","text":"plain"}]}`
	var cr CallResult
	if err := json.Unmarshal([]byte(raw), &cr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if cr.Content[0].Text != "plain" || cr.Content[0].Resource != nil {
		t.Fatalf("backward-compat broken: %+v", cr.Content[0])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/agent/mcpclient/ -run TestContentItem -v`
Expected: FAIL. `cr.Content[0].Resource` is undefined (compile error: `Resource` not a field of `ContentItem`).

- [ ] **Step 3: Write minimal implementation**

In `pkg/agent/mcpclient/client.go`, replace the `ContentItem` struct (currently lines 65-69) with:

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/agent/mcpclient/ -run TestContentItem -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/agent/mcpclient/client.go pkg/agent/mcpclient/client_test.go
git commit -m "feat(mcpclient): parse MCP embedded resources in tool results"
```

---

## Task 2: UI resource detection (`pkg/mcpui`)

**Files:**
- Create: `pkg/mcpui/types.go`
- Create: `pkg/mcpui/detect.go`
- Test: `pkg/mcpui/detect_test.go`

- [ ] **Step 1: Write the failing test**

Create `pkg/mcpui/detect_test.go`:

```go
package mcpui

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/mcpclient"
)

func html(uri, mime, text string) mcpclient.ContentItem {
	return mcpclient.ContentItem{
		Type:     "resource",
		Resource: &mcpclient.EmbeddedResource{URI: uri, MimeType: mime, Text: text},
	}
}

func TestDetectFindsHTMLUIResource(t *testing.T) {
	content := []mcpclient.ContentItem{
		{Type: "text", Text: "preamble"},
		html("ui://widget/1", "text/html", "<h1>hi</h1>"),
	}
	got, ok := Detect(content)
	if !ok {
		t.Fatal("expected detection")
	}
	if got.URI != "ui://widget/1" || got.HTML != "<h1>hi</h1>" {
		t.Fatalf("bad resource: %+v", got)
	}
}

func TestDetectIgnoresNonUIResource(t *testing.T) {
	content := []mcpclient.ContentItem{html("file:///x.txt", "text/plain", "data")}
	if _, ok := Detect(content); ok {
		t.Fatal("non-ui:// resource must not be detected")
	}
}

func TestDetectIgnoresPlainText(t *testing.T) {
	content := []mcpclient.ContentItem{{Type: "text", Text: "just text"}}
	if _, ok := Detect(content); ok {
		t.Fatal("plain text must not be detected")
	}
}

func TestDetectRemoteDomUnsupportedInPhase1(t *testing.T) {
	content := []mcpclient.ContentItem{
		html("ui://widget/2", "application/vnd.mcp-ui.remote-dom", "script"),
	}
	if _, ok := Detect(content); ok {
		t.Fatal("remote-dom must be unsupported (text fallback) in phase 1")
	}
}

func TestDetectReturnsFirstUIResource(t *testing.T) {
	content := []mcpclient.ContentItem{
		html("ui://a", "text/html", "<p>A</p>"),
		html("ui://b", "text/html", "<p>B</p>"),
	}
	got, _ := Detect(content)
	if got.URI != "ui://a" {
		t.Fatalf("want first resource ui://a, got %s", got.URI)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/mcpui/ -run TestDetect -v`
Expected: FAIL. package/`Detect`/`UIResource` undefined.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/mcpui/types.go`:

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package mcpui detects and models MCP-UI resources embedded in MCP tool
// results, so the host can render them as interactive blocks.
package mcpui

const (
	// UISchemePrefix marks an embedded resource as an MCP-UI payload.
	UISchemePrefix = "ui://"
	// MimeHTML is the phase-1 supported UI payload type.
	MimeHTML = "text/html"
	// MimeRemoteDOM is detected but unsupported in phase 1 (text fallback).
	MimeRemoteDOM = "application/vnd.mcp-ui.remote-dom"
)

// UIResource is a resolved, renderable MCP-UI payload.
type UIResource struct {
	URI      string
	MimeType string
	HTML     string // inline HTML for MimeHTML payloads
}
```

Create `pkg/mcpui/detect.go`:

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpui

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/mcpclient"
)

// Detect returns the first renderable MCP-UI resource in content, if any.
// A resource is renderable when its URI starts with "ui://" and its
// mimeType is supported (phase 1: text/html only).
func Detect(content []mcpclient.ContentItem) (*UIResource, bool) {
	for _, item := range content {
		r := item.Resource
		if r == nil || !strings.HasPrefix(r.URI, UISchemePrefix) {
			continue
		}
		if r.MimeType == MimeHTML {
			return &UIResource{URI: r.URI, MimeType: r.MimeType, HTML: r.Text}, true
		}
	}
	return nil, false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/mcpui/ -run TestDetect -v`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/mcpui/types.go pkg/mcpui/detect.go pkg/mcpui/detect_test.go
git commit -m "feat(mcpui): detect ui:// HTML resources in tool results"
```

---

## Task 3: MCP-UI action mapping (bridge)

**Files:**
- Create: `pkg/mcpui/bridge.go`
- Test: `pkg/mcpui/bridge_test.go`

MCP-UI iframes post messages shaped `{"type":"tool","payload":{"toolName":"x","params":{...}}}`,
`{"type":"prompt","payload":{"prompt":"..."}}`, `{"type":"link","payload":{"url":"..."}}`,
`{"type":"notify","payload":{"message":"..."}}`. This task parses them into a typed `Action`.

- [ ] **Step 1: Write the failing test**

Create `pkg/mcpui/bridge_test.go`:

```go
package mcpui

import "testing"

func TestMapActionTool(t *testing.T) {
	a, err := MapAction([]byte(`{"type":"tool","payload":{"toolName":"fs.read","params":{"path":"/x"}}}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a.Kind != ActionTool || a.ToolName != "fs.read" {
		t.Fatalf("bad action: %+v", a)
	}
	if string(a.Params) != `{"path":"/x"}` {
		t.Fatalf("bad params: %s", a.Params)
	}
}

func TestMapActionPrompt(t *testing.T) {
	a, err := MapAction([]byte(`{"type":"prompt","payload":{"prompt":"hello"}}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a.Kind != ActionPrompt || a.Text != "hello" {
		t.Fatalf("bad action: %+v", a)
	}
}

func TestMapActionLink(t *testing.T) {
	a, _ := MapAction([]byte(`{"type":"link","payload":{"url":"https://x.com"}}`))
	if a.Kind != ActionLink || a.URL != "https://x.com" {
		t.Fatalf("bad action: %+v", a)
	}
}

func TestMapActionNotify(t *testing.T) {
	a, _ := MapAction([]byte(`{"type":"notify","payload":{"message":"done"}}`))
	if a.Kind != ActionNotify || a.Text != "done" {
		t.Fatalf("bad action: %+v", a)
	}
}

func TestMapActionUnknownTypeErrors(t *testing.T) {
	if _, err := MapAction([]byte(`{"type":"explode"}`)); err == nil {
		t.Fatal("unknown type must error")
	}
}

func TestMapActionMalformedErrors(t *testing.T) {
	if _, err := MapAction([]byte(`not json`)); err == nil {
		t.Fatal("malformed json must error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/mcpui/ -run TestMapAction -v`
Expected: FAIL. `MapAction`, `Action`, `ActionTool`, etc. undefined.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/mcpui/bridge.go`:

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpui

import (
	"encoding/json"
	"fmt"
)

// ActionKind enumerates the MCP-UI postMessage action types we support.
type ActionKind string

const (
	ActionTool   ActionKind = "tool"
	ActionPrompt ActionKind = "prompt"
	ActionLink   ActionKind = "link"
	ActionNotify ActionKind = "notify"
)

// Action is a parsed MCP-UI message from a rendered UI iframe.
type Action struct {
	Kind     ActionKind
	ToolName string          // ActionTool
	Params   json.RawMessage // ActionTool
	Text     string          // ActionPrompt (prompt), ActionNotify (message)
	URL      string          // ActionLink
}

type rawMessage struct {
	Type    string `json:"type"`
	Payload struct {
		ToolName string          `json:"toolName"`
		Params   json.RawMessage `json:"params"`
		Prompt   string          `json:"prompt"`
		URL      string          `json:"url"`
		Message  string          `json:"message"`
	} `json:"payload"`
}

// MapAction parses a raw MCP-UI postMessage body into a typed Action.
func MapAction(raw []byte) (Action, error) {
	var m rawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return Action{}, fmt.Errorf("mcpui: malformed action: %w", err)
	}
	switch ActionKind(m.Type) {
	case ActionTool:
		return Action{Kind: ActionTool, ToolName: m.Payload.ToolName, Params: m.Payload.Params}, nil
	case ActionPrompt:
		return Action{Kind: ActionPrompt, Text: m.Payload.Prompt}, nil
	case ActionLink:
		return Action{Kind: ActionLink, URL: m.Payload.URL}, nil
	case ActionNotify:
		return Action{Kind: ActionNotify, Text: m.Payload.Message}, nil
	default:
		return Action{}, fmt.Errorf("mcpui: unknown action type %q", m.Type)
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/mcpui/ -run TestMapAction -v`
Expected: PASS (all six tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/mcpui/bridge.go pkg/mcpui/bridge_test.go
git commit -m "feat(mcpui): map MCP-UI postMessage actions to typed Action"
```

---

## Task 4: Wire detection into mcpproxy with text fallback

This task makes UI detection observable end-to-end at the proxy seam WITHOUT yet
rendering a block: on a UI hit, return a summary string; otherwise behave exactly
as today. The render call is injected behind a package-level hook so it can be
tested with a fake and so Task 5 can plug in the real renderer.

**Files:**
- Modify: `pkg/agent/tools/mcpproxy/mcpproxy.go` (handler tail, currently lines ~120-145)
- Test: `pkg/agent/tools/mcpproxy/mcpproxy_uihook_test.go` (create)

- [ ] **Step 1: Write the failing test**

Create `pkg/agent/tools/mcpproxy/mcpproxy_uihook_test.go`:

```go
package mcpproxy

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/mcpclient"
	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

func TestHandleResultRendersUIResource(t *testing.T) {
	var rendered *mcpui.UIResource
	prev := renderUI
	renderUI = func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
		rendered = ui
		return "Surfaced interactive UI from " + tool, nil
	}
	defer func() { renderUI = prev }()

	cr := &mcpclient.CallResult{Content: []mcpclient.ContentItem{
		{Type: "resource", Resource: &mcpclient.EmbeddedResource{
			URI: "ui://w/1", MimeType: "text/html", Text: "<h1>hi</h1>"}},
	}}
	out := handleResult(context.Background(), "demo.tool", cr)
	if out.IsError {
		t.Fatalf("unexpected error: %s", out.ErrorText)
	}
	if rendered == nil || rendered.HTML != "<h1>hi</h1>" {
		t.Fatalf("renderer not called with resource: %+v", rendered)
	}
	var got string
	_ = json.Unmarshal(out.Content, &got)
	if got != "Surfaced interactive UI from demo.tool" {
		t.Fatalf("bad summary content: %s", out.Content)
	}
}

func TestHandleResultFallsBackToTextOnNoUI(t *testing.T) {
	cr := &mcpclient.CallResult{Content: []mcpclient.ContentItem{
		{Type: "text", Text: "plain"},
	}}
	out := handleResult(context.Background(), "demo.tool", cr)
	if out.IsError {
		t.Fatalf("unexpected error: %s", out.ErrorText)
	}
	// non-UI results keep the existing marshalled CallResult body.
	var decoded mcpclient.CallResult
	if err := json.Unmarshal(out.Content, &decoded); err != nil {
		t.Fatalf("expected marshalled CallResult, got %s", out.Content)
	}
	if decoded.Content[0].Text != "plain" {
		t.Fatalf("bad fallback content: %s", out.Content)
	}
}

func TestHandleResultFallsBackWhenRenderFails(t *testing.T) {
	prev := renderUI
	renderUI = func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
		return "", context.Canceled // simulate render failure
	}
	defer func() { renderUI = prev }()

	cr := &mcpclient.CallResult{Content: []mcpclient.ContentItem{
		{Type: "resource", Resource: &mcpclient.EmbeddedResource{
			URI: "ui://w/1", MimeType: "text/html", Text: "<h1>hi</h1>"}},
	}}
	out := handleResult(context.Background(), "demo.tool", cr)
	if out.IsError {
		t.Fatalf("render failure must not error the tool call: %s", out.ErrorText)
	}
	var decoded mcpclient.CallResult
	if err := json.Unmarshal(out.Content, &decoded); err != nil {
		t.Fatalf("expected text fallback (marshalled CallResult), got %s", out.Content)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/agent/tools/mcpproxy/ -run TestHandleResult -v`
Expected: FAIL. `handleResult` and `renderUI` undefined.

- [ ] **Step 3: Write minimal implementation**

In `pkg/agent/tools/mcpproxy/mcpproxy.go`, add imports `"github.com/wavetermdev/waveterm/pkg/mcpui"` and `"github.com/wavetermdev/waveterm/pkg/agent/scope"`.

Add the indirection hook and result handler (place near the bottom, beside `stringifyContent`):

```go
// renderUI is the seam that turns a detected UI resource into a rendered
// block. It is a package var so tests can fake it and so the real
// implementation (pkg/mcpui/uihost) can be injected at init time.
var renderUI = func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
	// Default no-op until uihost registers itself; callers treat the
	// empty summary as "nothing rendered" and fall back to text.
	return "", nil
}

// handleResult converts an upstream CallResult into a registry.Result.
// On a detected, renderable UI resource it renders a block and returns a
// short text summary; on anything else (or any render failure) it falls
// back to the marshalled CallResult body, preserving today's behavior.
func handleResult(ctx context.Context, tool string, callRes *mcpclient.CallResult) registry.Result {
	if ui, ok := mcpui.Detect(callRes.Content); ok {
		session, _ := scope.AgentSessionIDFromContext(ctx)
		if summary, err := renderUI(ctx, session, tool, ui); err == nil && summary != "" {
			body, _ := json.Marshal(summary)
			return registry.Result{Content: body}
		}
		// fall through to text on render failure / empty summary
	}
	body, _ := json.Marshal(callRes)
	out := registry.Result{Content: body}
	if callRes.IsError {
		out.IsError = true
		out.ErrorText = stringifyContent(callRes.Content)
	}
	return out
}
```

Then, in `makeHandler`, replace the tail (currently):

```go
		body, _ := json.Marshal(callRes)
		out := registry.Result{Content: body}
		if callRes.IsError {
			out.IsError = true
			out.ErrorText = stringifyContent(callRes.Content)
		}
		return out, nil
```

with:

```go
		return handleResult(ctx, m.toolName(upstreamName), callRes), nil
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/agent/tools/mcpproxy/ -run TestHandleResult -v`
Expected: PASS (all three tests).
Then run the package suite to confirm no regression: `go test ./pkg/agent/tools/mcpproxy/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/agent/tools/mcpproxy/mcpproxy.go pkg/agent/tools/mcpproxy/mcpproxy_uihook_test.go
git commit -m "feat(mcpproxy): render UI resources via injectable hook, text fallback"
```

---

## Task 5: VDOM render host (`pkg/mcpui/uihost`)

This task renders the detected HTML into a VDOM block using `pkg/waveapp`, keyed
by `(session, tool)` so repeat calls update one block. The bridge from Task 3 maps
incoming iframe events to actions.

**Files:**
- Create: `pkg/mcpui/uihost/uihost.go`
- Test: `pkg/mcpui/uihost/uihost_test.go`

- [ ] **Step 1: Verify the VDOM serving API against source**

Before writing code, confirm these symbols exist and their signatures match:

Run: `grep -n "func MakeClient\|func (c \*Client) CreateVDomContext\|func (c \*Client) SetAtomVal\|func (c \*Client) SetGlobalEventHandler\|func (c \*Client) RegisterComponent\|func H(" pkg/waveapp/waveapp.go pkg/vdom/vdom.go`
Expected: each symbol is found. If `CreateVDomContext` takes a `*vdom.VDomTarget`, the render path below targets a new block via `&vdom.VDomTarget{NewBlock: "n"}`. If signatures differ, adjust the calls in Step 4 to match (the structure of the task does not change).

Also confirm how a `vdom.VDomEvent` identifies its source element and carries data:

Run: `grep -n "type VDomEvent" -A 12 pkg/vdom/vdom_types.go`
Expected: a struct with at least an event type/name and a data/value field. Record the exact field names; they are used by `eventData` in Task 6.

- [ ] **Step 2: Write the failing test**

Create `pkg/mcpui/uihost/uihost_test.go`. The test exercises the parts that do
NOT require a live wsh connection: session/tool keying and action dispatch. The
VDOM transport is injected via the `newRenderer` seam.

```go
package uihost

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

type fakeRenderer struct {
	html    string
	blockID string
}

func (f *fakeRenderer) Render(ctx context.Context, html string, onAction func(mcpui.Action)) (string, error) {
	f.html = html
	return f.blockID, nil
}

func TestRenderReusesBlockPerSessionTool(t *testing.T) {
	fakes := map[string]*fakeRenderer{}
	prev := newRenderer
	newRenderer = func(key string) renderer {
		if _, ok := fakes[key]; !ok {
			fakes[key] = &fakeRenderer{blockID: "blk-" + key}
		}
		return fakes[key]
	}
	defer func() { newRenderer = prev }()

	ui := &mcpui.UIResource{URI: "ui://w/1", MimeType: "text/html", HTML: "<h1>1</h1>"}
	s1, err := Render(context.Background(), "sessA", "demo.tool", ui)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	ui2 := &mcpui.UIResource{URI: "ui://w/1", MimeType: "text/html", HTML: "<h1>2</h1>"}
	s2, _ := Render(context.Background(), "sessA", "demo.tool", ui2)
	if s1 != s2 {
		t.Fatalf("same session+tool must reuse one block summary: %q vs %q", s1, s2)
	}
	if len(fakes) != 1 {
		t.Fatalf("expected 1 renderer reused, got %d", len(fakes))
	}
	if fakes[key("sessA", "demo.tool")].html != "<h1>2</h1>" {
		t.Fatalf("block not updated with new html: %q", fakes[key("sessA", "demo.tool")].html)
	}
}

func TestRenderSummaryMentionsTool(t *testing.T) {
	prev := newRenderer
	newRenderer = func(k string) renderer { return &fakeRenderer{blockID: "blk-x"} }
	defer func() { newRenderer = prev }()

	ui := &mcpui.UIResource{URI: "ui://w/1", MimeType: "text/html", HTML: "<h1>hi</h1>"}
	summary, err := Render(context.Background(), "sessA", "demo.tool", ui)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(summary, "demo.tool") {
		t.Fatalf("summary should mention the tool: %q", summary)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./pkg/mcpui/uihost/ -run TestRender -v`
Expected: FAIL. `Render`, `renderer`, `newRenderer`, `key` undefined.

- [ ] **Step 4: Write the implementation**

Create `pkg/mcpui/uihost/uihost.go`. The `renderer` interface isolates the wsh/VDOM
transport so logic is testable; `waveappRenderer` is the real implementation built
on the symbols verified in Step 1.

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package uihost renders detected MCP-UI resources into VDOM blocks and
// bridges iframe postMessage actions back to the agent. It is registered
// as the mcpproxy render hook at init time.
package uihost

import (
	"context"
	"fmt"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
	"github.com/wavetermdev/waveterm/pkg/vdom"
	"github.com/wavetermdev/waveterm/pkg/waveapp"
)

// renderer drives one VDOM block: it renders HTML and invokes onAction for
// each iframe message. Implementations are keyed by (session, tool).
type renderer interface {
	Render(ctx context.Context, html string, onAction func(mcpui.Action)) (blockID string, err error)
}

// newRenderer constructs a renderer for a given session+tool key. Overridable
// in tests. The default builds a waveapp-backed renderer.
var newRenderer = func(key string) renderer { return &waveappRenderer{} }

var (
	mu        sync.Mutex
	renderers = map[string]renderer{}
)

func key(session, tool string) string { return session + "\x00" + tool }

// Render renders ui into the block for (session, tool), creating the block on
// first use and updating it on subsequent calls. Returns a short summary for
// the agent.
func Render(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
	mu.Lock()
	k := key(session, tool)
	r, ok := renderers[k]
	if !ok {
		r = newRenderer(k)
		renderers[k] = r
	}
	mu.Unlock()

	blockID, err := r.Render(ctx, ui.HTML, func(a mcpui.Action) { Dispatch(ctx, session, a) })
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Surfaced interactive UI from %s in block %s", tool, blockID), nil
}

// waveappRenderer is the production renderer. It owns one waveapp.Client and
// the block it targets.
type waveappRenderer struct {
	once    sync.Once
	client  *waveapp.Client
	blockID string
	onAct   func(mcpui.Action)
}

func (w *waveappRenderer) Render(ctx context.Context, html string, onAction func(mcpui.Action)) (string, error) {
	w.onAct = onAction
	var initErr error
	w.once.Do(func() {
		c := waveapp.MakeClient(waveapp.AppOpts{
			RootComponentName: "App",
			TargetNewBlock:    true,
		})
		c.RegisterComponent("App", func(_ context.Context, _ struct{}) any {
			return vdom.H("iframe", map[string]any{
				"sandbox": "allow-scripts",
				"srcdoc":  c.GetAtomVal("html"),
				"style":   "width:100%;height:100%;border:0;",
			})
		})
		c.SetGlobalEventHandler(func(_ *waveapp.Client, ev vdom.VDomEvent) {
			if raw := eventData(ev); raw != nil {
				if a, err := mcpui.MapAction(raw); err == nil {
					w.onAct(a)
				}
			}
		})
		c.SetAtomVal("html", html)
		if err := c.CreateVDomContext(&vdom.VDomTarget{NewBlock: "n"}); err != nil {
			initErr = err
			return
		}
		w.client = c
		w.blockID = c.VDomContextBlockId
	})
	if initErr != nil {
		return "", initErr
	}
	// update path: push new html into the atom; the component re-renders.
	w.client.SetAtomVal("html", html)
	return w.blockID, nil
}
```

Add `pkg/mcpui/uihost/dispatch.go` for action routing (kept separate so its tests in
Task 6 stay focused):

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

// Dispatch routes a parsed MCP-UI action to the agent.
func Dispatch(ctx context.Context, session string, a mcpui.Action) {
	switch a.Kind {
	case mcpui.ActionTool:
		dispatchTool(ctx, session, a)
	case mcpui.ActionPrompt:
		dispatchPrompt(ctx, session, a)
	case mcpui.ActionLink:
		dispatchLink(ctx, a)
	case mcpui.ActionNotify:
		dispatchNotify(ctx, a)
	}
}
```

Add a temporary stub so the package compiles before Task 6 fills it in. Create
`pkg/mcpui/uihost/wire_stub.go`:

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
	"github.com/wavetermdev/waveterm/pkg/vdom"
)

// eventData extracts the raw postMessage JSON from a VDomEvent. Filled in
// Task 6 once the exact VDomEvent field is confirmed.
func eventData(ev vdom.VDomEvent) []byte { return nil }

func dispatchTool(ctx context.Context, session string, a mcpui.Action) {}
func dispatchPrompt(ctx context.Context, session string, a mcpui.Action) {}
func dispatchLink(ctx context.Context, a mcpui.Action)                   {}
func dispatchNotify(ctx context.Context, a mcpui.Action)                 {}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./pkg/mcpui/uihost/ -run TestRender -v`
Expected: PASS (both tests use the `fakeRenderer`, so the waveapp path is not exercised here).
Then: `go build ./pkg/mcpui/...`
Expected: builds clean.

- [ ] **Step 6: Register the hook so mcpproxy uses the real renderer**

In `pkg/agent/tools/mcpproxy/mcpproxy.go`, add an exported setter:

```go
// SetRenderer installs the UI render hook (called by pkg/mcpui/uihost at init).
func SetRenderer(fn func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error)) {
	renderUI = fn
}
```

Create `pkg/mcpui/uihost/register.go`:

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// This file wires the renderer into mcpproxy via SetRenderer (avoids an
// import cycle: mcpproxy never imports uihost).
package uihost

import (
	"github.com/wavetermdev/waveterm/pkg/agent/tools/mcpproxy"
)

func init() {
	mcpproxy.SetRenderer(Render)
}
```

Confirm the binary that mounts MCP proxies imports `pkg/mcpui/uihost` (blank import
for the side effect). Find the mount site:

Run: `grep -rln "mcpproxy.Activate\|mcpproxy.Mount" cmd pkg --include=*.go`
Add `_ "github.com/wavetermdev/waveterm/pkg/mcpui/uihost"` to that file's import block.

- [ ] **Step 7: Verify build and commit**

Run: `go build ./...`
Expected: builds clean.

```bash
git add pkg/mcpui/uihost/ pkg/agent/tools/mcpproxy/mcpproxy.go
git add -A  # picks up the blank-import edit at the mount site
git commit -m "feat(uihost): render MCP-UI resources into VDOM blocks, keyed by session+tool"
```

---

## Task 6: Action dispatch + frontend iframe message bridge

Fills in the dispatch stubs and the frontend wiring so iframe messages reach the
backend and actions take effect.

**Files:**
- Replace: `pkg/mcpui/uihost/wire_stub.go` with `pkg/mcpui/uihost/wire.go` (real implementations)
- Test: `pkg/mcpui/uihost/dispatch_test.go` (create)
- Modify: `frontend/app/view/vdom/vdom-model.tsx`
- Modify: `frontend/app/view/vdom/vdom-utils.tsx`

- [ ] **Step 1: Confirm agent re-entry, open-link, and event-data APIs**

Run: `grep -rn "func Call\|func Submit\|Prompt" pkg/agent/registry/*.go pkg/agent/*.go | head`
Run: `grep -rn "openExternal\|OpenExternal\|open.*url\|OpenLink" pkg/wshrpc/wshclient/wshclient.go | head`
Run: `grep -n "type VDomEvent" -A 12 pkg/vdom/vdom_types.go`

Record three things, used as the bracketed substitutions in Step 3:
- `<REGISTRY_CALL>`: the exact registry entrypoint to re-enter a tool call with scope/approval (likely `registry.Call(ctx, registry.CallRequest{...})`; confirm name + signature).
- `<OPEN_URL>`: the exact wsh client call to open an external URL.
- `<EVENT_DATA_FIELD>`: the `VDomEvent` field that carries the iframe message payload (e.g. `ev.Value` or `ev.Data`).

If no chat-injection API exists for `prompt`, `dispatchPrompt` only logs (do not invent an API).

- [ ] **Step 2: Write the failing test**

Create `pkg/mcpui/uihost/dispatch_test.go`:

```go
package uihost

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

func TestDispatchToolCallsRegistry(t *testing.T) {
	var calledName string
	var calledArgs json.RawMessage
	prev := callTool
	callTool = func(ctx context.Context, session, name string, args json.RawMessage) {
		calledName, calledArgs = name, args
	}
	defer func() { callTool = prev }()

	Dispatch(context.Background(), "sessA", mcpui.Action{
		Kind: mcpui.ActionTool, ToolName: "fs.read", Params: json.RawMessage(`{"path":"/x"}`),
	})
	if calledName != "fs.read" || string(calledArgs) != `{"path":"/x"}` {
		t.Fatalf("tool not dispatched: %s %s", calledName, calledArgs)
	}
}

func TestDispatchLinkOpensURL(t *testing.T) {
	var opened string
	prev := openLink
	openLink = func(url string) { opened = url }
	defer func() { openLink = prev }()

	Dispatch(context.Background(), "sessA", mcpui.Action{Kind: mcpui.ActionLink, URL: "https://x.com"})
	if opened != "https://x.com" {
		t.Fatalf("link not opened: %q", opened)
	}
}
```

- [ ] **Step 3: Run test to verify it fails, then implement**

Run: `go test ./pkg/mcpui/uihost/ -run TestDispatch -v`
Expected: FAIL. `callTool`, `openLink` undefined.

Delete `pkg/mcpui/uihost/wire_stub.go` and create `pkg/mcpui/uihost/wire.go`. Replace
the bracketed substitutions with the exact symbols recorded in Step 1:

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"
	"encoding/json"
	"log"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
	"github.com/wavetermdev/waveterm/pkg/vdom"
)

// callTool re-enters the agent tool path (scope + approval applied there).
// Overridable in tests.
var callTool = func(ctx context.Context, session, name string, args json.RawMessage) {
	// e.g.: _, _ = registry.Call(scope.WithAgentSessionID(ctx, session),
	//   registry.CallRequest{Name: name, Arguments: args, AgentSessionID: session})
	<REGISTRY_CALL>
}

// openLink opens a URL externally. Overridable in tests.
var openLink = func(url string) {
	<OPEN_URL>
}

func dispatchTool(ctx context.Context, session string, a mcpui.Action) {
	callTool(ctx, session, a.ToolName, a.Params)
}

func dispatchPrompt(ctx context.Context, session string, a mcpui.Action) {
	// No chat-injection API in phase 1 (see Step 1). Log and move on.
	log.Printf("[mcpui] prompt action (session=%s): %s", session, a.Text)
}

func dispatchLink(ctx context.Context, a mcpui.Action) { openLink(a.URL) }

func dispatchNotify(ctx context.Context, a mcpui.Action) {
	log.Printf("[mcpui] notify: %s", a.Text)
}

// eventData extracts the raw postMessage JSON from a VDomEvent, using the
// field confirmed in Step 1.
func eventData(ev vdom.VDomEvent) []byte {
	b, _ := json.Marshal(<EVENT_DATA_FIELD>)
	return b
}
```

Run: `go test ./pkg/mcpui/uihost/ -run TestDispatch -v`
Expected: PASS.

- [ ] **Step 4: Frontend: allow the iframe element**

In `frontend/app/view/vdom/vdom-utils.tsx`, locate the allowlist that gates which
`tag` values render and which props pass through.

Run first to locate it: `grep -n "iframe\|allowed\|AllowedTags\|tagAllow\|whitelist\|validTags\|restrict" frontend/app/view/vdom/vdom-utils.tsx`
Then add `iframe` to that collection and permit the `sandbox`, `srcdoc`, and `style`
attributes on it. The edit is additive (add the tag name and its allowed attributes
to the existing structure).

- [ ] **Step 5: Frontend: forward iframe messages to the backend**

In `frontend/app/view/vdom/vdom-model.tsx`, add a `window` `message` listener active
while a vdom block is mounted. It filters to messages whose `source` is a rendered
iframe `contentWindow` and forwards `event.data` to the backend as a `VDomEvent`,
using the same RPC path the model already uses to send events (found via the file's
top imports: `RpcApi` / `TabRpcClient`). Implement against the model's real
event-send method (read the existing send path first):

```ts
useEffect(() => {
    const onMsg = (e: MessageEvent) => {
        if (!isOurIframe(e.source)) return; // only our sandboxed iframe
        model.sendBackendEvent({ type: "message", data: e.data });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
}, [model]);
```

Match `model.sendBackendEvent` to whatever the model actually exposes for sending a
`VDomEvent` (confirm by reading the existing event-send path in `vdom-model.tsx`).
The backend `SetGlobalEventHandler` (Task 5) receives it; `eventData` unmarshals it.

- [ ] **Step 6: Run frontend checks**

Run: `npx vitest run frontend/app/view/vdom` (if vdom tests exist).
Run: `npx tsc --noEmit`
Expected: type-checks pass; any existing vdom tests pass.

- [ ] **Step 7: Commit**

```bash
git add pkg/mcpui/uihost/ frontend/app/view/vdom/vdom-model.tsx frontend/app/view/vdom/vdom-utils.tsx
git commit -m "feat(mcpui): dispatch UI actions and forward iframe messages to backend"
```

---

## Task 7: End-to-end integration test with a fixture MCP server

**Files:**
- Create: `pkg/mcpui/testdata/ui-echo-server/main.go` (tiny stdio MCP server whose one tool returns a `ui://` HTML resource).
- Create: `pkg/agent/tools/mcpproxy/mcpproxy_e2e_test.go`

- [ ] **Step 1: Write the fixture MCP server**

Create `pkg/mcpui/testdata/ui-echo-server/main.go`: a minimal stdio JSON-RPC server
implementing `initialize`, `tools/list` (one tool `echo_ui`), and `tools/call`
returning:

```json
{"content":[{"type":"resource","resource":{"uri":"ui://echo/1","mimeType":"text/html","text":"<button>hi</button>"}}]}
```

Implement the three methods over stdin/stdout newline-delimited JSON-RPC, matching
the framing `pkg/agent/mcpclient` expects. Confirm the framing first:

Run: `grep -n "ReadString\|WriteString\|Content-Length\|\\\\n" pkg/agent/mcpclient/client.go | head`
and read `readLoop`/`request` to copy the exact wire format.

- [ ] **Step 2: Write the failing integration test**

Create `pkg/agent/tools/mcpproxy/mcpproxy_e2e_test.go`:

```go
package mcpproxy

import (
	"context"
	"encoding/json"
	"os/exec"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

func TestE2EUIResourceTriggersRender(t *testing.T) {
	bin := t.TempDir() + "/ui-echo-server"
	if out, err := exec.Command("go", "build", "-o", bin,
		"github.com/wavetermdev/waveterm/pkg/mcpui/testdata/ui-echo-server").CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v\n%s", err, out)
	}

	var renderedHTML string
	prev := renderUI
	renderUI = func(ctx context.Context, session, tool string, ui *mcpui.UIResource) (string, error) {
		renderedHTML = ui.HTML
		return "rendered " + tool, nil
	}
	defer func() { renderUI = prev }()

	m := &Mount{EnableEnv: "MCPUI_E2E", Namespace: "echo.", Command: bin}
	t.Setenv("MCPUI_E2E", "1")
	if n := Activate(m); n != 1 {
		t.Fatalf("want 1 tool registered, got %d", n)
	}

	// makeHandler returns (registry.Result, error); call the upstream tool name.
	res, err := m.makeHandler("echo_ui")(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("handler err: %v", err)
	}
	if res.IsError {
		t.Fatalf("handler returned error: %s", res.ErrorText)
	}
	if renderedHTML != "<button>hi</button>" {
		t.Fatalf("render hook not invoked with UI html, got %q", renderedHTML)
	}
}
```

(If reading `makeHandler` shows a different return arity, adjust the call accordingly.)

- [ ] **Step 3: Run to verify it fails, then make it pass**

Run: `go test ./pkg/agent/tools/mcpproxy/ -run TestE2E -v`
Expected: initially FAIL (fixture missing); after Step 1 is complete and the Task 4
handler wiring is in place, PASS.

- [ ] **Step 4: Commit**

```bash
git add pkg/mcpui/testdata/ pkg/agent/tools/mcpproxy/mcpproxy_e2e_test.go
git commit -m "test(mcpui): e2e fixture MCP server proves ui:// triggers render"
```

---

## Task 8: Manual verification in Crowe Code + demo block

- [ ] **Step 1:** Build and launch Crowe Code per `BUILD.md` (confirm the dev target in `Taskfile.yml`, e.g. `task dev`).
- [ ] **Step 2:** Set the enable env for a UI-capable MCP mount (or mount the Task 7 fixture server), start an agent session in a block, and invoke the tool that returns a `ui://` HTML resource.
- [ ] **Step 3:** Confirm a new block renders the HTML inside a sandboxed iframe (inspect: `sandbox="allow-scripts"`, no `allow-same-origin`).
- [ ] **Step 4:** Click a control wired to a `tool` action; confirm Wave's approval prompt appears and, on approval, the tool runs.
- [ ] **Step 5:** Re-invoke the same tool; confirm the SAME block updates (no second block spawns).
- [ ] **Step 6:** Return a malformed resource; confirm the agent still gets text and nothing crashes. Capture the demo in block `ff960a07-f360-4454-a80e-0cfcf9938df7`.

---

## Self-Review Notes

- **Spec coverage:** ContentItem extension (Task 1, spec Components.1); Detect with html-only phase-1 and remote-dom deferred (Task 2, spec Components.2 + Scope); action bridge (Tasks 3 and 6, spec Action bridge); mcpproxy seam + fallback (Task 4, spec Components.4 + Error handling); VDOM render host + block reuse (Task 5, spec Components.3); frontend iframe sandbox + message forwarding (Task 6, spec Components.5 + Security); testing (Tasks 2,3,4,5,6,7, spec Testing); demo surface block (Task 8, spec Scope phase-1).
- **Verify-then-build gates (not placeholders):** Task 5 Step 1 (waveapp/VDomEvent signatures) and Task 6 Step 1 (`<REGISTRY_CALL>`, `<OPEN_URL>`, `<EVENT_DATA_FIELD>`). Each binds to a complex existing event system and ships with a concrete grep to resolve the exact symbol before code is written.
- **Type consistency:** the `renderUI`/`SetRenderer` signature matches across mcpproxy (Task 4) and uihost registration (Task 5 Step 6). `mcpui.Action` fields are used identically in Tasks 3, 5, 6. `Render(ctx, session, tool, *UIResource) (string, error)` is identical in uihost (Task 5) and the mcpproxy hook (Task 4). `key(session, tool)` is defined once in uihost and reused by the test.
```