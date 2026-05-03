# Crowe Code Merger + Per-Block Agent Capability Scoping

Date: 2026-05-02
Status: Draft
Builds on: `2026-04-28-agentic-orchestrator-design.md` (Tool Registry + HTTP/WS adapter)

## Goal

Replace the standalone `Crowe Code.app` (a VS Code fork) with a code-editing experience built on the existing Crowe Terminal substrate. Pair the merger with a per-block capability scoping model so agents calling tools through the Tool Registry are gated by the block they were spawned in, not just by global allowlist.

## Why merge

Three reasons:

1. **One block model.** WaveTerm's block + layout system already gives us movable, persistent, multi-pane workspaces. Re-implementing that in a VS Code fork is cost we already paid in this codebase.
2. **One agent surface.** The 2026-04-28 spec defined a single Tool Registry shared across surfaces. The VS Code fork can't participate in that registry without a parallel adapter; the merged app inherits it for free.
3. **Differentiator.** Cursor and Warp both expose AI as a chat sidebar. None of them let the agent live as a first-class block alongside terminal, browser, editor, and system blocks, sharing layout and per-block scoping. That asymmetry is the product wedge.

## Non-goals

- VS Code extension compatibility. Crowe Code v2 hosts a Monaco editor, not the VS Code extension host. The Marketplace ecosystem is not in scope.
- Replacing the Tool Registry from the 2026-04-28 spec. We extend it.
- Cloud sync or multi-user editing. Single user, single host.
- Migrating settings or keybindings from the legacy Crowe Code fork automatically.

## Two new design decisions

| Decision | Choice | Why |
|---|---|---|
| Editor host | **Monaco (the editor engine VS Code uses) embedded in a new block type** | Same syntax/LSP behavior users expect, without inheriting the VS Code app shell. |
| Agent capability scope | **Per-block capability grants on top of the existing global allowlist** | A terminal block can run `terminal.exec_safe`; only the editor block the agent was spawned in can call `editor.apply_edit` against that block. Stops a single granted capability from cascading across panes. |

## Architecture

We add two layers on top of what 2026-04-28 already locked in.

### Layer 1: New block type

**Location:** `frontend/app/view/codeeditor/` (follows the create-view skill structure)

A `codeeditor` block type. Block model:

- Backing file path (or virtual buffer for unsaved edits)
- Monaco instance with project-aware language services
- LSP client wired to the host's language servers (`gopls`, `tsserver`, `pyright`, etc.) via a new `pkg/lsp/` package that bridges the existing block IPC to LSP processes
- View state persisted alongside other block view states

The editor block registers in `BlockRegistry` next to the existing terminal, web, and chat block types. Layout, persistence, and split/merge come for free from the substrate.

### Layer 2: Editor tools registered in the Tool Registry

The Tool Registry (defined in 2026-04-28 at `pkg/agent/registry/`) gets a new owning package that registers the editor surface:

```
pkg/agent/tools/editor/
  open_file.go        // editor.open_file(path, line?)
  apply_edit.go       // editor.apply_edit(block_id, range, text)
  read_buffer.go      // editor.read_buffer(block_id, range?)
  diagnostics.go      // editor.diagnostics(block_id)
  format.go           // editor.format(block_id)
  search_workspace.go // editor.search_workspace(query, scope?)
```

Same `Mutating` flag and `AllowlistPattern` metadata pattern as the existing terminal tools. `editor.apply_edit` is mutating; `editor.read_buffer` is not.

### Layer 3: Per-block capability grants (this spec's main addition)

This is the part that doesn't exist yet.

**Capability:** the right to call a specific tool from the registry against a specific target. Capabilities are scoped to a block at spawn time by default.

**Grant model.** Each block carries a `capability_grant` map:

```go
// pkg/agent/scope/grant.go
type CapabilityGrant struct {
    BlockID       string
    AgentSessionID string

    // toolname -> mode. Mode is one of "deny", "ask", "allow".
    Tools map[string]GrantMode

    // For tools that operate on a target (a file path, a URL, a block_id),
    // an optional pattern restricting which targets are reachable.
    TargetPatterns map[string][]string

    // Time-boxed. nil = session.
    ExpiresAt *time.Time
}
```

**Default grants per block type.** When an agent block is created in a workspace, the default grants depend on the block type the agent was spawned next to:

| Spawned next to | Default grants on the agent |
|---|---|
| Terminal block | `terminal.exec_safe: ask`, `terminal.propose_command: ask`, `terminal.read_output: allow` (target-restricted to that terminal block) |
| Editor block | `editor.read_buffer: allow`, `editor.diagnostics: allow`, `editor.apply_edit: ask`, `editor.format: ask` (target-restricted to that editor block) |
| Browser block | `browser.snapshot: allow`, `browser.navigate: ask`, `browser.fill_form: ask` (target-restricted to that browser block) |
| Empty workspace | `system.metrics: allow`. Nothing else. The agent must request capabilities explicitly. |

The agent never gets `terminal.exec_safe: allow` by default. That default is `ask`, gated by the point-of-action UI from 2026-04-28. The user can promote a capability to `allow` after seeing it run successfully N times (the existing learned-allowlist mechanism), but the promotion is per-block-pair, not global.

**Why per-block, not per-tool.** A user trusts an agent to run `git status` in their terminal block but not necessarily to apply edits to a sensitive file in an editor block in the same workspace. Global allowlist alone produces over-broad trust. Per-block grants keep the scope where the user's intuition already lives: "what can this agent do to *that* pane."

**Storage.** Grants persist with the workspace (alongside block view states). When the workspace is reopened, grants come back; nothing is hardcoded to a session.

**UI.**

1. **Per-block padlock affordance** in the block header strip. Closed = default grants. Open = grants are non-default; click reveals what's promoted/demoted.
2. **Capability inspector pane** (a new auxiliary view, not a block type) accessible from the block menu. Lists every grant the block has, with promote/demote/expire buttons. Logs the last N tool calls and their outcomes.
3. **Point-of-action gate** (already designed in 2026-04-28) reads the grant before showing the confirmation dialog. If the grant is `allow`, no dialog. If `ask`, dialog with "remember for this block" option that updates the grant. If `deny`, the call fails synchronously with a typed error the agent can react to.

### How the existing global allowlist still applies

Global allowlist patterns remain the outer fence. A grant cannot promote a tool to `allow` for a pattern that the global allowlist marks as `deny` (e.g., `rm -rf /` is globally denied, no per-block grant overrides it). A grant CAN demote a globally allowed tool (per-block tightening). This is intentional asymmetry: defense-in-depth runs from outer fence inward, and the inner fence can only be more restrictive.

## Implementation phases

| Phase | Scope | Deliverable |
|---|---|---|
| 1 | Monaco block type | `frontend/app/view/codeeditor/` registered, opens files, scroll, save. No LSP yet. |
| 2 | LSP bridge | `pkg/lsp/` for Go, TS, Python language servers. `editor.diagnostics` tool wired. |
| 3 | Editor tools | All `editor.*` tools registered in the Tool Registry. Existing 2026-04-28 transports surface them. |
| 4 | Per-block capability grants | `pkg/agent/scope/` with grant struct + storage. Point-of-action gate updated to consult grants. UI padlock + inspector pane. |
| 5 | Default-grant policy | The table above wired into block creation. Agent block defaults differ based on adjacent block type. |
| 6 | Legacy retirement | `Crowe Code.app` (VS Code fork) removed from `/Applications`. README + landing page redirect users to the new app. |

Phase 4 is the load-bearing one. Phases 1-3 ship value incrementally even without the scoping primitive (you get a code-editing block in your terminal); Phase 4 is what makes the combination an actual differentiator.

## Open questions

1. **Cross-block agent operations.** When an agent in workspace A wants to drive a block in workspace B (e.g., open a file from a different project), does the grant follow the agent or stay with the source block? Suggested default: cross-workspace ops always require an explicit `ask`, regardless of grant. Worth pressure-testing.
2. **Composite capabilities.** Some flows need a sequence (`editor.read_buffer → reasoning → editor.apply_edit`). Should a single grant cover a "diff session" rather than per-call? Possibly v2.
3. **Audit log location.** Per-block call log is part of the inspector pane, but a workspace-wide audit (every tool call, every block, every outcome) needs a home. Likely a new `audit` block type that subscribes to the Tool Registry's call event stream.

## Success criteria

- [ ] User can open a file in a Monaco block, agent in adjacent terminal can read its diagnostics without a confirmation prompt, but cannot edit it without one.
- [ ] User promotes `editor.apply_edit` to `allow` for that specific editor block; agent can now edit that file freely. The same agent in a different editor block still requires a prompt.
- [ ] Workspace closes and reopens; the promotion persists for that block, not the agent.
- [ ] `Crowe Code.app` removed; users opening files via Finder land in the new app via URL handler.

## References

- `docs/superpowers/specs/2026-04-28-agentic-orchestrator-design.md` (Tool Registry + transports + point-of-action gate)
- `.kilocode/skills/create-view/SKILL.md` (block type registration pattern)
- `.kilocode/skills/electron-api/SKILL.md` (renderer ↔ main process IPC)
- WaveTerm upstream block system (`pkg/blockcontroller`, `frontend/app/block/`)
