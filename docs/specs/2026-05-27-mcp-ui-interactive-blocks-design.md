# MCP-UI Interactive Blocks — Design

**Date:** 2026-05-27
**Status:** Approved (design); implementation plan pending
**Repo:** crowe-terminal (Crowe Code)
**Author:** Michael Crowe / Crowe Logic

## Summary

Make Crowe Code render **MCP-UI resources** returned by any MCP server into a
live, interactive block instead of flattening them to text. When a proxied MCP
tool returns an embedded resource whose URI begins with `ui://`, Crowe Code
spawns (or updates) a VDOM block that renders the server-provided HTML in a
sandboxed iframe and bridges the MCP-UI `postMessage` action protocol back to
the agent.

This is a **host/consumer-first** build: the leverage is that every server
mounted through `pkg/agent/tools/mcpproxy` — `crowe-logic-mcp`,
`crowe-mail-mcp`, `vellum-mcp`, `crowe-portfolio`, and any third-party server —
gets rich interactive UI for free, with no per-server work.

## Background / current state

Two primitives already exist in the fork:

- **VDOM** (`pkg/vdom/`, `pkg/waveapp/waveapp.go`, `frontend/app/view/vdom/`):
  a backend Go process can drive real DOM inside a block. This is the rendering
  vehicle.
- **mcpproxy** (`pkg/agent/tools/mcpproxy/mcpproxy.go` + `pkg/agent/mcpclient`):
  proxies upstream MCP servers' tools into the agent, namespaced and
  mutation-gated.

The gap: `mcpclient.ContentItem` is currently `{Type, Text, Data}` and does not
parse MCP embedded *resources* (`resource.uri`, `resource.mimeType`,
`resource.text`/`blob`). MCP tool results that carry a `ui://` UI payload are
therefore flattened to text by `stringifyContent` and discarded. The core of
this feature is to stop discarding that payload and render it.

## Architecture

```
agent tool call
   └─ mcpproxy.Call ──► upstream MCP server
                         returns Content[] (text | image | resource)
        │
        ▼
   pkg/mcpui.Detect(Content)  ── no UI resource ──► existing stringify → text to agent
        │ found ui:// resource
        ▼
   pkg/mcpui/uihost.Render(session, toolName, resource)
        │  ensures a VDOM block (waveapp), renders sandboxed <iframe srcdoc=…>
        ▼
   returns SHORT text summary to the agent
        ("Surfaced interactive UI from <tool> in block <id>")

   user interacts in iframe ──postMessage──► VDOM event ──► uihost bridge
        ├─ tool   → re-enter agent tool path (gated by Wave approval)
        ├─ prompt → inject into chat
        ├─ link   → open externally
        └─ notify → toast / result posted back into the iframe
```

The entire feature hangs off the single point in `mcpproxy` where
`callRes.Content` is currently flattened to text.

## Components

### 1. `mcpclient.ContentItem` extension
Add embedded-resource support, backward-compatible:

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
    Text     string `json:"text,omitempty"` // inline text (e.g. HTML)
    Blob     string `json:"blob,omitempty"` // base64 binary
}
```

Existing consumers that read only `Type`/`Text`/`Data` are unaffected.

### 2. `pkg/mcpui` (new) — pure detection + types
No side effects, trivially unit-testable.

```go
type UIResource struct {
    URI      string
    MimeType string
    HTML     string // resolved inline HTML for text/html
}

// Detect returns the first UI resource in a content array, if any.
// A UI resource has uri prefixed "ui://" and a supported mimeType.
func Detect(content []mcpclient.ContentItem) (*UIResource, bool)
```

Phase 1 supports `text/html`. `application/vnd.mcp-ui.remote-dom` is detected
but treated as unsupported (text fallback) until a later phase.

### 3. `pkg/mcpui/uihost` (new) — block lifecycle + bridge
Owns the rendered block. Keyed by `(agentSessionId, toolName)` so repeated calls
**update** one block rather than spawning a new block per call. Drives a
`waveapp` VDOM tree containing a sandboxed `<iframe srcdoc>` plus the action
bridge.

```go
// Render ensures a VDOM block for (session, tool) and renders the UI resource.
// Returns a short human/agent-readable summary line, or an error.
func Render(ctx context.Context, session, toolName string, ui *UIResource) (summary string, err error)
```

### 4. `mcpproxy` hook
After `cli.Call`, run `mcpui.Detect`. On hit, call `uihost.Render` and return
its summary as the tool result text. On miss or **any** error, fall through to
today's `stringifyContent` behavior. Rendering is strictly additive.

### 5. Frontend VDOM iframe support
Ensure `frontend/app/view/vdom/vdom-utils.tsx` permits an `iframe` element with
`sandbox` and `srcdoc` props, and wires its `message` events back through the
VDOM event channel so the bridge can receive them. This is the only frontend
change.

## Action bridge (MCP-UI postMessage protocol)

The iframe runs untrusted server HTML and speaks MCP-UI's standard messages.
Each maps to an existing capability:

| iframe message      | mapped to                          | gating                          |
|---------------------|------------------------------------|---------------------------------|
| `tool` (call MCP tool) | re-enter agent tool path        | **Wave approval flow** (`IsMutating`) |
| `prompt`            | push text into the agent chat      | none                            |
| `link`              | open URL externally                | none                            |
| `notify` / result   | toast + `messageResponse` posted back into iframe | none             |

UI can *request* actions; it cannot *act* unsupervised. Tool actions always pass
through Wave's existing approval gate.

## Security

- iframe `sandbox="allow-scripts"` **without** `allow-same-origin`: server HTML
  cannot reach the app origin, cookies, or wsh.
- `srcdoc` only in phase 1 (no remote-URL frames), with a payload size cap.
  Oversize payloads fall back to text.
- Every `tool` action from the iframe passes through Wave's approval flow,
  reusing each mount's `IsMutating` classification.
- `ui://` URIs are treated as opaque identifiers, namespaced per server; they
  are not dereferenced as network URLs.

## Error handling — never break a tool call

All of the following fall back to the current text behavior and log a warning;
none of them fail the tool call:

- malformed or unparseable resource
- block creation / render failure
- payload over the size cap
- unsupported mimeType (e.g. remote-dom in phase 1)

## Scope

### Phase 1 (this spec)
- `text/html` srcdoc rendering in a VDOM block
- block reuse keyed by `(session, tool)`
- `tool` / `prompt` / `link` / `notify` actions
- full text fallback on every error path
- demo target surface: block `ff960a07-f360-4454-a80e-0cfcf9938df7`

### Deferred (later phases)
- `application/vnd.mcp-ui.remote-dom` rendering
- remote-URL iframes (`ui://` resolving to external content)
- streaming async `messageResponse`
- multi-block dashboards / multiple concurrent UIs per tool

## Testing

- **Go unit:** `Detect` over varied content arrays (no resource, non-ui
  resource, ui html, ui remote-dom, multiple); bridge message→action mapping;
  every fallback path.
- **Integration:** a fixture MCP server returning a `ui://` HTML resource;
  assert `mcpproxy` triggers a render and still returns summary text.
- **Frontend:** iframe renders with correct `sandbox` + `srcdoc`; `message`
  events reach the VDOM event channel.

## Open questions

None blocking. Remote-dom rendering and external-URL frames are explicitly
deferred, not unresolved.
