# Crowe Terminal — Agentic Orchestrator Design

Date: 2026-04-28
Status: Approved (locked, moving to implementation)

## Goal

Turn Crowe Terminal from a terminal-with-AI-chat into a **single-window agentic operator** where CroweLM (via the Foundry bridge) can drive:

- a real shell (the user's terminal block),
- a real web browser (the in-window browser block, plus Playwright MCP for heavy automation),
- and a live system monitor (CPU, RAM, disk, network, processes) —

all from natural-language commands, with safety gates the user actually trusts.

## Non-goals

- New window paradigm. We stay inside Wave's existing block + layout system.
- Replacing CroweLM's tool-calling with a custom agent loop. We use the OpenAI-compatible tool-calling already supported by the bridge.
- Cloud-side orchestration. Everything runs on the user's machine; only model calls leave.
- Multi-user / collaborative sessions. Single user, single host.

## Three locked design decisions

| Decision | Choice | Why |
|---|---|---|
| Terminal execution model | **Hybrid (safe headless + visible-pane mutations)** | Speed for read-only commands; user sees and gates anything that mutates state. |
| Browser execution model | **Hybrid (in-window for casual + Playwright MCP for heavy)** | Visibility and trust for one-shot lookups; full automation power for scripted multi-step flows. |
| Confirmation gate | **Point-of-action UI + learned allowlist** | Mutating actions land un-pressed at the pane where they'll happen; safe patterns get remembered so the user isn't approving `ls` every time. |

## Architecture

**One tool registry, two transport adapters** (hexagonal). Domain logic lives once at the center; transports at the edges.

```
┌─────────────────────────────────────────────────────────┐
│              Crowe Terminal (Go backend)                │
│                                                         │
│   ┌──────────────────────────────────────────────┐      │
│   │           Tool Registry                       │      │
│   │  (single source of truth: schemas + impls)   │      │
│   └────────┬─────────────────────────┬───────────┘      │
│            │                         │                  │
│   ┌────────▼─────────┐     ┌─────────▼────────┐         │
│   │ HTTP/WS adapter  │     │  MCP adapter     │         │
│   │ 127.0.0.1:8012   │     │  (v1.1, staged)  │         │
│   │ bearer auth      │     │                  │         │
│   └────────┬─────────┘     └──────────────────┘         │
└────────────┼────────────────────────────────────────────┘
             │
       ┌─────▼──────┐
       │ Foundry    │ ◄──── CroweLM tool_calls
       │ bridge     │ ◄──── Playwright MCP (existing)
       │ 127.0.0.1  │
       │ :8011      │
       └────────────┘
```

**v1 scope:** Tool Registry + HTTP/WS adapter. Foundry bridge fetches tool catalog from the terminal at session start, advertises tools on every chat completion, routes `tool_calls` back over HTTP.

**v1.1 (staged, additive):** MCP adapter on the same registry. Other Crowe surfaces (Crowe Code, Foundry Studio) and external clients (Claude Desktop, Cursor) get the same tools by speaking MCP.

## Components

### 1. Tool Registry (Go, new)

**Location:** `pkg/agent/registry/`

A single in-process registry mapping tool names to:

- JSON Schema for arguments (advertised to the model)
- A handler function (`func(ctx, args) (result, error)`)
- Metadata: `mutating: bool`, `allowlist_pattern: string`, `default_block: blocktype`

Tools are registered at startup by their owning package (e.g., the terminal-tools package registers `terminal.exec_safe` and `terminal.propose_command`; the system-monitor package registers `system.metrics`). The registry exposes `List()` and `Call(ctx, name, args)`.

### 2. HTTP/WS adapter (Go, new)

**Location:** `pkg/agent/transport/http/`

- `GET /v1/tools` — returns the catalog (OpenAI tool-format JSON)
- `POST /v1/call` — `{name, arguments, tool_call_id}` → tool result (sync for fast tools; long tools stream over WS)
- `GET /v1/events` (WebSocket) — stream tool-call lifecycle events for the AI block UI (proposed → approved → running → result)
- Auth: `Authorization: Bearer <token>`. Token lives at `~/.config/crowe-terminal/control-token` (chmod 600), generated on first run.
- Bind: `127.0.0.1:8012` only. Reject any non-loopback request.

### 3. Tools (v1)

| Tool | Mutating? | Default behavior |
|---|---|---|
| `terminal.exec_safe` | no | Run command in a fresh subprocess (NOT a persistent shell — no shared env/cwd state across calls), 30s default timeout, return stdout/stderr/exit. cwd defaults to the cwd of the most-recently-focused terminal block (or `$HOME` if none). Refuses commands matching the mutating-pattern denylist (rm, sudo, git push, npm install, anything with `>`/`>>` outside `/tmp`, anything with shell metachars triggering subshells, etc.). |
| `terminal.propose_command` | yes | Type the command into the user's active terminal block, leave cursor on the line, do NOT press Enter. Publishes a `command_proposed` event so the UI can show a hint. If no terminal block is open, return an error suggesting the model call `blocks.create({type: "term"})` first. |
| `terminal.list_blocks` | no | List terminal blocks the agent can target. |
| `browser.in_window.navigate` | no | Navigate the in-window browser block to a URL. |
| `browser.in_window.read` | no | Return the visible page text + a screenshot. |
| `browser.in_window.click` | yes (DOM mutation possible) | Click selector — gated unless allowlisted. |
| `browser.in_window.type` | yes | Type into selector — gated. |
| `browser.playwright.delegate` | yes | Hand a multi-step task to Playwright MCP with a structured plan. Gated by default. |
| `system.metrics` | no | Snapshot of CPU, RAM, disk, network, top processes. |
| `system.metrics.stream` | no | WS-only: stream metrics at 1Hz (used by the monitor block). |
| `allowlist.check` | no | Check if a candidate command/selector is allowlisted. |
| `allowlist.add` | yes (mutates user config) | Add a pattern to allowlist — only ever called via the UI's "remember this" affordance, never directly by the model. |
| `blocks.create` | no | Open a new block (terminal/browser/monitor) in the current workspace. |
| `blocks.focus` | no | Focus an existing block. |

### 4. System Monitor block (TS/React, new)

**Location:** `frontend/app/view/sysmon/`

A new BlockView (per `.kilocode/skills/create-view/SKILL.md` pattern) that:

- Subscribes to `system.metrics.stream` over the agent transport WS
- Renders compact charts (CPU per core, RAM, network in/out, top 5 processes by CPU)
- Has a small "Ask Crowe Logic about this" affordance that injects current metrics + recent process list into the AI block as context

Block type id: `"sysmon"`. Registered in the existing `BlockRegistry`. Inherits Crowe Logic Dark theme.

### 5. AI block enhancements (TS/React, edit existing)

**Location:** `frontend/app/view/aichat/` (or wherever today's AI block lives — verify during impl)

- Render `tool_call` messages from the model as **action cards** with command/target/preview + Approve / Edit / Reject buttons
- For `terminal.propose_command`: card shows the command typed into the target terminal block; "Approve" sends Enter to that block, "Edit" focuses the line, "Reject" clears it
- For `browser.in_window.click` / `.type`: card shows a screenshot crop with the targeted element outlined; same buttons
- For `terminal.exec_safe` and other non-mutating tools: card auto-collapses after success, expandable on click
- A small "Allow `<pattern>` from now on" checkbox under the Approve button — checking it before approving calls `allowlist.add` then approves

### 6. Allowlist (Go + TS settings UI)

**Location:**
- Persistence: `~/.config/crowe-terminal/allowlist.json` — list of patterns with `kind: "command"|"selector"|"url"`, `pattern: string`, `added_at`, `notes`
- Pattern matching: glob for commands/URLs (`git status`, `git log *`, `ls *`), CSS-selector exact-match for browser actions
- Settings UI: editable list under Settings → Crowe Agent → Allowlist (add, remove, toggle, notes)

Defaults shipped with v1: `git status`, `git log *`, `ls *`, `pwd`, `cat *.md`, `cat *.json`, `head *`, `tail *`, `grep *`, `rg *`, `which *`, `whoami`, `date`, `uptime`, `df -h`, `free -h`, `ps *`, `kubectl get *`, `docker ps *`, `node --version`, `python --version`, `go version`. Mutating verbs (`rm`, `mv`, `cp`, `chmod`, `chown`, `sudo`, `git push`, `git reset --hard`, `npm install`, `pip install`, `make`, `task`, anything with `&&` to a mutating verb) are **denylisted from allowlist** — they always re-confirm even if a user tries to allowlist them.

### 7. Foundry bridge changes (Python, edit)

**Location:** `~/Projects/crowe-logic-foundry/cli/openai_bridge.py` (or wherever the bridge entrypoint is — verify during impl)

- On startup: probe `127.0.0.1:8012/v1/tools`, fetch catalog, store. If unreachable, run as today (no tools).
- On every chat completion: include the tool catalog in the `tools` parameter to CroweLM.
- On `tool_calls` in the response: POST each call to `/v1/call`, append the tool result to the conversation, re-call CroweLM. Loop until the model returns a `finish_reason: stop` with no tool calls.
- Stream tool-call lifecycle events to the terminal's `/v1/events` WS so the AI block UI can show live status.
- Auth: read bearer from `~/.config/crowe-terminal/control-token`.

### 8. Playwright MCP wiring

The bridge already needs to be an MCP client (for Playwright). The `browser.playwright.delegate` tool's handler in the terminal **does not call Playwright directly** — it returns a structured "delegate-this" payload. The bridge sees this, calls Playwright MCP with the payload, then returns the Playwright result back to the terminal as the tool result. This keeps Playwright credentials/configuration in the bridge (where MCP clients already live) and the terminal's tool surface clean.

## Data flow — happy path

User types in AI block: *"Find every Stripe webhook handler and open the first one in a new editor pane."*

1. AI block sends user message to bridge.
2. Bridge calls CroweLM with tool catalog. Model emits two tool calls: `terminal.exec_safe(rg "stripe.*webhook")` then waits.
3. Bridge POSTs to `/v1/call`. Terminal's exec_safe handler runs the ripgrep, returns hits. WS event to UI: action card auto-collapses (read-only succeeded).
4. Bridge appends tool result, re-calls CroweLM. Model emits `blocks.create({type: "preview", path: <first hit path>})` and a final assistant message.
5. Bridge POSTs the create call. Terminal opens a preview block. WS event to UI.
6. Final assistant message renders as normal chat text in AI block.

## Data flow — mutation gate

User: *"Push the current branch to origin."*

1. Model emits `terminal.propose_command({block: "active", command: "git push origin HEAD"})`.
2. Terminal's handler types the command into the active terminal block, leaves cursor on line, does **not** press Enter. Publishes `command_proposed` event.
3. AI block UI renders an action card: shows the command, the target block, an Approve / Edit / Reject row, and a "remember this exact pattern" checkbox (unchecked by default for `git push *` because it's denylisted from allowlist).
4. User clicks Approve. UI calls a thin internal endpoint that publishes a `command_approved` event for that block; terminal block sends Enter.
5. Tool result (exit code, summary) returns to the bridge. Model continues.

If user clicks Reject: terminal block clears the line, tool returns `{rejected: true}` to the bridge so the model knows.

## Error handling

- **Bridge unreachable:** AI block shows a banner "CroweLM offline — start Foundry bridge"; tools advertised as empty list. Terminal still works as a regular terminal.
- **Tool registry unreachable from bridge:** bridge falls back to chat-only (no tools), logs the failure once per session, surfaces in AI block as "agent tools offline."
- **Tool execution error:** error returned to model as a tool result; model decides whether to retry or report. UI shows the action card in error state with the stderr.
- **Mutation timeout:** if a `propose_command` is neither approved nor rejected within 5 minutes, treat as rejected, return `{rejected: true, reason: "timeout"}` to the model, clear the line.
- **Allowlist file corrupted:** load defaults, surface a banner, do NOT silently overwrite — let user choose to reset.
- **Playwright MCP failure:** bridge returns the failure as the `browser.playwright.delegate` tool result; model can fall back to the in-window browser.

## Testing

- **Go unit tests:** registry registration + dispatch; HTTP adapter auth; allowlist matching (including denylist override); each tool handler with mocked dependencies.
- **TS unit tests:** action-card rendering for each tool kind; allowlist-add affordance gating on denylist; sysmon block subscription lifecycle.
- **Integration:** stand up the HTTP adapter against a test bridge stub, run a scripted conversation through `tools_call` paths, assert correct events on the WS.
- **End-to-end smoke (manual at first, scripted later via TestDriver):**
    1. Launch terminal, confirm AI block lists CroweLM models with tool support.
    2. "Show me the top 5 processes by CPU" → sysmon snapshot in chat.
    3. "Run `git status`" → auto-runs (allowlisted), result in chat.
    4. "Run `rm /tmp/foo.txt`" → command typed into terminal, action card with Approve.
    5. "Open github.com/MichaelCrowe11/crowe-terminal in a new tab" → in-window browser navigates.
    6. "Log into <test site>, fill out the contact form, screenshot the result" → delegated to Playwright MCP, screenshot streamed back.

## Out of scope for v1 (deferred to v1.x)

- MCP adapter on the registry (v1.1)
- Multi-host / SSH'd-into-server tool execution (v1.2)
- Per-tool rate limiting and budget tracking (v1.2)
- Tool call replay / undo for safe-undoable actions (v1.3)
- Voice input to the AI block (already on roadmap separately)

## File-by-file change list

### New files
- `pkg/agent/registry/registry.go` — Tool registry core
- `pkg/agent/registry/types.go` — Tool, Schema, Handler types
- `pkg/agent/transport/http/server.go` — HTTP/WS adapter
- `pkg/agent/transport/http/auth.go` — bearer token load/generate
- `pkg/agent/tools/terminal/exec_safe.go`
- `pkg/agent/tools/terminal/propose_command.go`
- `pkg/agent/tools/terminal/list_blocks.go`
- `pkg/agent/tools/browser/in_window.go`
- `pkg/agent/tools/browser/playwright_delegate.go`
- `pkg/agent/tools/system/metrics.go`
- `pkg/agent/tools/allowlist/allowlist.go`
- `pkg/agent/tools/blocks/blocks.go`
- `pkg/agent/denylist/denylist.go` — mutating-pattern matchers shared by exec_safe and allowlist
- `frontend/app/view/sysmon/sysmon.tsx`
- `frontend/app/view/sysmon/sysmon-model.ts`
- `frontend/app/view/sysmon/charts.tsx`
- `frontend/app/view/aichat/actioncard.tsx` (new sibling to existing aichat code)
- `frontend/app/view/aichat/actioncard-model.ts`
- `frontend/app/settings/agent-allowlist.tsx`
- `docs/superpowers/specs/2026-04-28-agentic-orchestrator-design.md` (this file)

### Edited files
- `cmd/server/main.go` — start agent transport; register tools
- `pkg/blockcontroller/blockregistry.go` — register `sysmon` block type
- `frontend/app/view/aichat/aichat.tsx` — render action cards from `tool_call` messages
- `frontend/app/store/global.ts` — agent transport WS client
- `pkg/wconfig/defaultconfig/*.json` — defaults for the new block + agent settings
- `~/Projects/crowe-logic-foundry/cli/openai_bridge.py` — tool discovery, tool-call routing, WS event emission
- `README.md` — document the new agent capability

## Acceptance criteria

- Launching Crowe Terminal with the Foundry bridge running results in CroweLM tool calls being executed end-to-end.
- A new `sysmon` block can be opened from the block menu and shows live CPU/RAM/processes.
- `git status` runs without prompting after first use; `rm <anything>` always types into a terminal block and waits.
- The Foundry bridge can run without the terminal (chat-only fallback).
- The terminal can run without the Foundry bridge (no AI block tools, terminal works fine).
- All existing Wave terminal/browser/SSH features still work (no regressions).

## Risks

- **Foundry bridge changes touch a separate repo.** Coordinate via the parallel-sessions feedback rule. Lock the bridge changes behind a feature flag (`CROWE_AGENT_TOOLS=1`) so the bridge stays compatible with non-terminal callers.
- **Action-card UX is the make-or-break.** If approval feels heavy, users will turn it off and lose safety. The allowlist's "remember this" must be one click, not three.
- **System monitor cross-platform.** macOS/Linux/Windows have different process/CPU APIs. Use `gopsutil` (already common in Wave's deps tree — verify; if not, add it).
