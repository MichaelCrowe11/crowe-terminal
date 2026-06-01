# MCP-UI Interactive Blocks: Revision 2 (Option C): supersedes Tasks 5-6

**Date:** 2026-05-27
**Reason:** The original plan rendered UI by driving a VDOM context in-process via `pkg/waveapp`. Investigation proved `waveapp.Client.Connect()` hard-requires a `WAVETERM_JWT` env var + live Unix socket that only exist for external app processes spawned into a terminal block. The agent tool handler runs inside the server, so that path nil-panics at runtime. Additionally `vdom.VDomEvent` has no free-form payload field, making the iframe-action transport awkward.

**Decision:** Pivot to a dedicated frontend block view (`mcpui`). The server creates/updates an `mcpui`-view block (HTML stored in block meta); the frontend view renders the sandboxed `<iframe srcdoc>` and speaks the MCP-UI postMessage protocol natively, sending inbound actions to the server via a new typed wsh command `McpUiActionCommand`. This is higher fidelity to the MCP-UI standard and lower complexity than an in-process VDOM render loop.

**Unchanged and still merged:** Task 1 (ContentItem), Task 2 (Detect), Task 3 (MapAction/Action), Task 4 (mcpproxy `renderUI` seam + fallback). The `renderUI` hook signature and the `uihost` `Render`/`renderer`/`key`/reuse contract + their tests are preserved. `register.go` (`mcpproxy.SetRenderer(Render)`) is unchanged.

**Removed:** `pkg/mcpui/uihost/waveappRenderer` and its `pkg/waveapp`+`pkg/vdom` imports; `wire_stub.go` (VDOM-specific `eventData`).

---

## Verified signatures (read from the tree, do not guess)

- `wshclient.CreateBlockCommand(w *wshutil.WshRpc, data wshrpc.CommandCreateBlockData, opts *wshrpc.RpcOpts) (waveobj.ORef, error)`: `pkg/wshrpc/wshclient/wshclient.go:183`
- `wshrpc.CommandCreateBlockData{ TabId string; BlockDef *waveobj.BlockDef; RtOpts *waveobj.RuntimeOpts; Magnified bool; Ephemeral bool; Focused bool; TargetBlockId string; TargetAction string }`: `pkg/wshrpc/wshrpctypes.go:337`. `TargetAction` in {replace, splitright, splitdown, splitleft, splitup}.
- `waveobj.BlockDef{ Files map[string]*FileDef; Meta MetaMapType }`; `MetaMapType = map[string]any`.
- `wshclient.GetBareRpcClient() *wshutil.WshRpc`: `pkg/wshrpc/wshclient/barerpcclient.go:26`. Use `&wshrpc.RpcOpts{Route: wshutil.DefaultRoute}`.
- `wstore.DBFindTabForBlockId(ctx context.Context, blockId string) (string, error)`: `pkg/wstore/wstore_dbops.go:364`.
- `wshclient.SetMetaCommand(w *wshutil.WshRpc, data wshrpc.CommandSetMetaData, opts *wshrpc.RpcOpts) error`; `CommandSetMetaData{ ORef waveobj.ORef; Meta waveobj.MetaMapType }`: `pkg/wshrpc/wshrpctypes.go:284`.
- `registry.Default() *Registry` and `(*Registry).Call(ctx, req CallRequest) (Result, error)`: `pkg/agent/registry/registry.go:29,77`. Scope is enforced from CTX (`scope.BlockIDFromContext`/`AgentSessionIDFromContext`), so stamp ctx with `scope.WithBlockID` + `scope.WithAgentSessionID` before calling.
- External URL open: `open.Run(url string) error` from `github.com/skratchdot/open-golang/open` (already imported in `pkg/wshrpc/wshserver/wshserver.go:23`).
- Frontend: `getBlockMetaKeyAtom(blockId, key)` (`frontend/app/store/global.ts`), `makeFeBlockRouteId` (`frontend/app/store/wshrouter.ts`), view registration in `frontend/app/block/blockregistry.ts`, `ViewModel` types in `frontend/types/custom.d.ts`. `RpcApi.*Command(TabRpcClient, data)` for FE->server calls (generated).
- **Confirm before use:** the Go ORef constructor name in `pkg/waveobj` (FE uses `WOS.makeORef`; Go likely `waveobj.MakeORef("block", id)`: verify). Meta-key namespacing uses `"prefix:key"` strings; `view` key is `waveobj.MetaKey_View`.

---

## Task 5A: Go block-meta render host

Replace `waveappRenderer` with a `blockRenderer` that creates an `mcpui` block on first render and updates its meta on reuse.

**Files:** Modify `pkg/mcpui/uihost/uihost.go` (drop waveappRenderer + waveapp/vdom imports; widen `newRenderer` seam to capture calling-block id + session + tool). Create `pkg/mcpui/uihost/blockrenderer.go` + `blockrenderer_test.go`. Delete `wire_stub.go` (its dispatch stubs move to Task 6B). The `onAction` closure in `renderer.Render` is dead for Option C (actions arrive via the wsh command in Task C), so the renderer may ignore it; keep or simplify the interface as cleanest.

**Seam design:** Introduce a small injectable "block ops" interface so tests never hit real RPC:
```go
type blockOps interface {
	create(ctx context.Context, tabID string, meta map[string]any) (blockID string, err error)
	setMeta(ctx context.Context, blockID string, meta map[string]any) error
	findTab(ctx context.Context, blockID string) (tabID string, err error)
}
```
Default impl wraps `wshclient.CreateBlockCommand`/`SetMetaCommand` via `GetBareRpcClient()` and `wstore.DBFindTabForBlockId`. Tests inject a fake recording calls.

**blockRenderer:** holds `callingBlockID, session, tool string`, `ops blockOps`, `mu sync.Mutex`, `blockID string`. `Render(ctx, html, _)`: lock; if `blockID == ""` resolve tab (`ops.findTab(ctx, callingBlockID)`) then `ops.create(ctx, tabID, {"view":"mcpui","mcpui:html":html,"mcpui:session":session,"mcpui:tool":tool})` and store blockID; else `ops.setMeta(ctx, blockID, {"mcpui:html":html})`. Return blockID.

**TDD:** keep `uihost_test.go` reuse + summary tests (adapt the fake to the widened `newRenderer` signature). New `blockrenderer_test.go`: (1) first Render creates exactly once with `view==mcpui` + html + resolved tab; (2) second Render updates via setMeta with new html and does NOT create again; (3) findTab error surfaces as Render error. Commit when green + `go vet`.

## Task 6B: bridge `intent` + real action dispatch

**Files:** Modify `pkg/mcpui/bridge.go` (add `ActionIntent = "intent"`, `Action.Intent string`, `rawMessage.Payload.Intent`, and an `intent` case in `MapAction` carrying Intent + Params). Modify `pkg/mcpui/uihost/dispatch.go` (add `case mcpui.ActionIntent`). Create `pkg/mcpui/uihost/action.go` with real `dispatchTool/dispatchPrompt/dispatchLink/dispatchNotify/dispatchIntent`, behind injectable seams. Tests: extend `bridge_test.go` for intent; new `action_test.go`.

**Dispatch seams (for testability):**
```go
var callTool = func(ctx context.Context, name string, args json.RawMessage) {
	_, _ = registry.Default().Call(ctx, registry.CallRequest{Name: name, Arguments: args})
}
var openLink = func(url string) { _ = open.Run(url) }
```
`dispatchTool(ctx, session, a)`: read `blockID, _ := scope.BlockIDFromContext(ctx)`; stamp `ctx = scope.WithBlockID(scope.WithAgentSessionID(ctx, session), blockID)`; `callTool(ctx, a.ToolName, a.Params)`. `dispatchLink`: `openLink(a.URL)`. `dispatchPrompt/Notify/Intent`: minimal (log only in phase 1; no invented APIs).

`Dispatch(ctx, session, a)` switches on `a.Kind` to the five dispatchers. (Reads blockID from ctx, so the wsh handler in Task C must stamp ctx with the calling block id.)

**TDD:** bridge intent parse test; `action_test.go` swaps `callTool`/`openLink` with fakes, asserts tool dispatch passes the right name+args and that ctx carries session+block scope; link calls opener; unknown/empty kinds do not panic. Commit when green + `go vet`.

## Task 9C: `McpUiActionCommand` wsh command + codegen

**Files:** Modify `pkg/wshrpc/wshrpctypes.go` (add interface method + `CommandMcpUiActionData`). Run `task generate` (regenerates `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`: never hand-edit generated files). Implement on `pkg/wshrpc/wshserver/wshserver.go`. Add a leaf entrypoint `uihost.HandleAction(ctx, data)` if a `wshserver -> uihost` import cycle appears.

```go
// in WshRpcInterface (near CreateBlockCommand):
McpUiActionCommand(ctx context.Context, data CommandMcpUiActionData) error

type CommandMcpUiActionData struct {
	BlockId   string          `json:"blockid"`
	Session   string          `json:"session"`
	Type      string          `json:"type"`
	ToolName  string          `json:"toolname,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Prompt    string          `json:"prompt,omitempty"`
	Url       string          `json:"url,omitempty"`
	Intent    string          `json:"intent,omitempty"`
	Message   string          `json:"message,omitempty"`
	MessageId string          `json:"messageid,omitempty"`
}
```
JSON tags lowercase, no underscores (project rule). Server impl maps the data to a `mcpui.Action` and calls `uihost.Dispatch(ctx, data.Session, action)` after stamping ctx with `scope.WithBlockID(ctx, data.BlockId)` and `scope.WithAgentSessionID(ctx, data.Session)`.

**TDD (Go side):** a `uihost.HandleAction`/dispatch-entry test (reuse Task 6B fakes) asserting a `CommandMcpUiActionData` for a `tool` reaches `callTool` with correct name/args and scoped ctx. Verify generated files updated (presence of `McpUiActionCommand` in wshclientapi.ts + `CommandMcpUiActionData` in gotypes.d.ts). Per project rules do not run `go build`; rely on the editor/compile + `task generate`. Depends on 6B.

## Task 10D: frontend `mcpui` view

**Files:** Create `frontend/app/view/mcpui/mcpui-model.ts` (`McpUiViewModel implements ViewModel`; `viewType="mcpui"`; `htmlAtom = getBlockMetaKeyAtom(blockId, "mcpui:html")`). Create `frontend/app/view/mcpui/mcpui.tsx` (component). Modify `frontend/app/block/blockregistry.ts` (import + `BlockRegistry.set("mcpui", McpUiViewModel)`).

**Component behavior:** render `<iframe sandbox="allow-scripts" srcDoc={html} className="w-full h-full border-0" />` (NO allow-same-origin). Attach a `window` `message` listener scoped to `event.source === iframeRef.current?.contentWindow`. Handle MCP-UI messages `{ type, payload, messageId? }`:
- `ui-lifecycle-iframe-ready`: optionally postMessage initial data back (targetOrigin "*").
- `ui-size-change`: no-op in phase 1.
- `tool|prompt|link|intent|notify`: call `RpcApi.McpUiActionCommand(TabRpcClient, { blockid: blockId, session, type, ...payloadFields, messageid })`; if `messageId` present, post `ui-message-received` ack back into the iframe (targetOrigin "*").
Because the sandbox has no allow-same-origin the iframe origin is "null"; host->iframe posts must use `targetOrigin: "*"` and match on `event.source`, never on origin.

**Scope note:** the `session` for the FE->server call is read from block meta (`mcpui:session`), which the render host stored in Task 5A. Defer async tool-result-back-into-iframe (`ui-message-response`) and a dedicated `mcpui-wsh.tsx` to a later phase unless cheap. Depends on 9C (needs the generated `RpcApi.McpUiActionCommand`).

**Verification:** `npx tsc --noEmit` clean; the view renders in a manual smoke (Task 8).

---

## Task ordering
5A and 6B are pure Go, independently testable (5A first for the cleanest seam). 9C depends on 6B (dispatch) + codegen. 10D depends on 9C (generated client). Then Task 7 (e2e) and Task 8 (manual) carry over, retargeted at the `mcpui` view.

## Open risks
- `waveobj.MakeORef` exact name: confirm in 5A before the SetMeta path.
- `wshserver -> uihost` import cycle: if it appears in 9C, route dispatch through a leaf `uihost.HandleAction`.
- MCP-UI ack/response message shapes (`ui-message-received`/`ui-message-response`) are implemented from the protocol spec, not from in-repo code; validate against a real MCP-UI client in Task 8.
