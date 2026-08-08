# Hypheus Agent User Guide

How to use the AI panel and operator tool surface that ships with Hypheus.

---

## TL;DR

Open the AI panel (right side of the window). Pick a CroweLM model (Auto is
fine). Chat. The model has native tools to drive your terminal, visible blocks,
browser, host metrics, and macOS, and can be extended with opt-in MCP-based
tool families.

```
"What's my CPU usage?"            -> ct_system_metrics
"Open github.com in my browser"   -> ct_browser_in_window_navigate
"Run git status"                  -> ct_terminal_exec_safe
"Read the open terminal"          -> ct_terminal_read_scrollback
"Inspect this block"              -> ct_widget_capture_screenshot
"Run rm /tmp/x"                   -> typed into the terminal, you press Enter
"Open Music"                      -> ct_system_tell_app
```

---

## How the tools work — the safety story

Every tool is one of:

* **Safe (read-only)** — runs immediately, no confirmation. e.g. `system.metrics`,
  `terminal.exec_safe`, `browser.in_window.read`.

* **Mutating** — needs user approval. The model can call them, but execution
  pauses until you act:
  * `terminal.propose_command` types the command into your visible terminal
    block but does **not** press Enter. You read the line, press Enter to run
    or `Ctrl+U` to clear.
  * `browser.in_window.click/type/scroll` etc. dispatch the action immediately
    in the in-window webview — visible to you. You can navigate away or grab
    the URL bar at any moment.
  * `system.run_applescript` runs immediately because AppleScript is its own
    sandbox; if the model misbehaves you'll see it in the host UI.

* **Refused** — `terminal.exec_safe` will refuse anything matching the
  mutating-pattern denylist (`rm`, `sudo`, `git push`, `npm install`, redirects
  outside `/tmp`, subshells, pipes to a shell, etc.). The model is told to
  call `terminal.propose_command` instead, which routes through the
  Enter-confirmation path above.

The denylist always wins. Even if you try to allowlist `rm *`, the addition is
refused.

---

## Native operator tools

### `system.*` — host telemetry + macOS automation

| Tool | What it does | Mutating? |
|---|---|---|
| `system.metrics(topn?)` | CPU per core, memory, disk, network, top processes by CPU. | no |
| `system.run_applescript(script, timeout_sec?)` | Run literal AppleScript via osascript. macOS only. | yes |
| `system.tell_app(app, command, timeout_sec?)` | Sugar for `tell application "X" to Y`. | yes |

### `terminal.*` — drive your shell

| Tool | What it does | Mutating? |
|---|---|---|
| `terminal.exec_safe(command, cwd?, timeout_sec?)` | Run a read-only shell command in a fresh subprocess. Refuses anything mutating. | no |
| `terminal.propose_command(blockid, command)` | Type a command into the visible terminal block, leaving the cursor on the line. **Does not press Enter.** | yes |
| `terminal.list_blocks(view?)` | List open blocks (terminal/browser/sysinfo/etc.) so the model can target one. | no |
| `terminal.read_scrollback(blockid, line_start?, count?, last_command?)` | Read visible terminal output with pagination and last-command status. | no |

### `widget.*` — inspect and control visible blocks

| Tool | What it does | Mutating? |
|---|---|---|
| `widget.capture_screenshot(blockid)` | Capture any visible block as a PNG data URL. | no |
| `widget.focus(blockid)` | Focus a block for subsequent keyboard or operator actions. | yes |
| `widget.open_in_crowecode(path, language?)` | Open a local file in a Crowe Code block. | yes |

### `browser.in_window.*` — drive the same-window web block

All take `blockid` (use `terminal.list_blocks(view="web")` to discover).

| Tool | What it does | Mutating? |
|---|---|---|
| `browser.in_window.navigate(blockid, url)` | Load a URL in the in-window webview. | yes |
| `browser.in_window.read(blockid, max_chars?)` | Visible page text + URL + title. | no |
| `browser.in_window.click(blockid, selector)` | Click a CSS selector. | yes |
| `browser.in_window.type(blockid, selector, text, press_enter?, clear?)` | Type into an input/textarea + fire input/change events. | yes |
| `browser.in_window.screenshot(blockid)` | PNG via Electron `capturePage`, returned as base64. | no |
| `browser.in_window.eval(blockid, script, timeout_ms?)` | Run arbitrary JS in the page, return the result. | yes |
| `browser.in_window.wait_for(blockid, selector, absent?, timeout_ms?)` | Poll until a selector appears (or disappears). | no |
| `browser.in_window.scroll(blockid, selector? \| dy?, behavior?)` | scrollIntoView OR scrollBy. | yes |
| `browser.in_window.hover(blockid, selector)` | Dispatch mouseenter+mouseover+mousemove. | yes |
| `browser.in_window.get_attr(blockid, selector, attr)` | Read attr / text / html / value. | no |
| `browser.in_window.select_option(blockid, selector, value? \| label?)` | Set a `<select>` value + fire change. | yes |
| `browser.in_window.list_links(blockid, limit?)` | All visible `<a>` tags as `{text, href}`. | no |

### `allowlist.*` — manage what runs without confirmation

| Tool | What it does | Mutating? |
|---|---|---|
| `allowlist.check(kind, candidate)` | Check if a candidate is allowlisted. | no |
| `allowlist.list()` | Show all allowed patterns. | no |
| `allowlist.add(kind, pattern, notes?)` | Add a pattern. **Refuses anything matching the mutating denylist.** | yes |

`kind` is one of `command`, `url`, or `selector`. Patterns support glob (`*`).

The persisted file lives at:
* macOS: `~/Library/Application Support/crowe-terminal/allowlist.json`
* Linux: `~/.config/crowe-terminal/allowlist.json`
* Windows: `%AppData%\crowe-terminal\allowlist.json`

Default-allowlisted commands include: `git status`, `git log`, `ls`, `pwd`,
`cat *.md`, `head`, `tail`, `grep`, `rg`, `df -h`, `free -h`, `ps`,
`kubectl get *`, `docker ps`, version checks, etc. ~30 entries seeded at
first launch.

---

## Opt-in: outbound MCP families

These connect external MCP servers as agent tools through the same registry.
Set the env var, restart Hypheus, and the tools surface alongside the native
operator tools.

| Env var | What it adds | Notes |
|---|---|---|
| `CROWE_AGENT_PLAYWRIGHT=1` | Full Playwright MCP — `browser.click`, `browser.navigate`, `browser.evaluate`, etc. Headless Chromium controlled by the model. | Needs `npx`. Use when you want browser automation that's invisible to the user (multi-step scrapes, scheduled flows). For interactive "watch the AI browse" UX, prefer `browser.in_window.*` instead. |
| `CROWE_AGENT_FS=1`<br>`CROWE_AGENT_FS_ROOTS=/abs/path1,/abs/path2` | `@modelcontextprotocol/server-filesystem` — `fs.read_file`, `fs.write_file`, `fs.list_directory`, etc. constrained to the listed roots. | Defaults to `~/Documents` if FS_ROOTS unset. Mutating ops (write/move/delete) flagged so Wave's approval path handles them. |
| `CROWE_AGENT_FETCH=1` | `@modelcontextprotocol/server-fetch` — HTTP fetch as a tool. All read-only. | Use for "look up X" without opening a browser block. |
| `CROWE_AGENT_GITHUB=1`<br>`GITHUB_PERSONAL_ACCESS_TOKEN=...` | `@modelcontextprotocol/server-github` — issues, PRs, file ops on remote repos. | Mutating tools flagged via prefix match (`create_/update_/delete_/merge_/push_/...`). |

---

## Opt-out: disable the agent transport entirely

`CROWE_AGENT_DISABLED=1` — wavesrv will skip starting the agent transport on
8012. Useful if you want the terminal without the agent surface.

---

## Architecture in one paragraph

Crowe Terminal forks Wave Terminal. The Go backend (`wavesrv`) starts a tool
registry + HTTP/WS adapter on `127.0.0.1:8012` (auth: `X-AuthKey` header
sharing the wave authkey). Each tool is a Go function exposed by name. When
the user spawns the Foundry bridge (Python, on `127.0.0.1:8011`), the bridge
imports `tools/crowe_terminal.py` which fetches the catalog from 8012 and
registers each tool as a Foundry-side proxy with real signatures so CroweLM
sees them via Foundry's normal tool-calling path.

The same registry is also exposed through:

* **Wave aiusechat adapter** (in-process Go) — registers each tool as a Wave
  `ToolDefinition`, so any Wave AI mode talking to a non-Foundry endpoint
  (OpenAI, Anthropic, Gemini) gets the tools too with native Wave action-card
  rendering.
* **MCP stdio adapter** — the standalone `crowe-mcp` binary advertises the
  tools to any MCP-aware client (Claude Desktop, Cursor, etc.) Wire it up:
  ```jsonc
  // ~/Library/Application Support/Claude/claude_desktop_config.json
  {
    "mcpServers": {
      "crowe-terminal": {
        "command": "/path/to/crowe-mcp"
      }
    }
  }
  ```

So one tool, three transports, one host.

---

## Troubleshooting

**"WaveAI configuration error" on New Chat**
The AI mode config didn't resolve. Check `~/Library/Application Support/waveterm-dev/`
(dev) or `~/Library/Application Support/waveterm/` (prod) for a stale config.
Default modes ship with `ai:provider: openai`, `ai:endpoint: http://127.0.0.1:8011/v1/chat/completions`,
`ai:apitoken: local-bridge-no-auth`.

**"Invalid model gpt-5.4"**
Outdated config — was a phantom model name from upstream. Already fixed in
defaults. If you still see it, your tab has a saved `defaultmode` pointing at
`waveaibuilder@default` from before the fix; pick a CroweLM mode from the
picker once and it'll persist.

**`single-instance-lock` / `address already in use` on relaunch**
A previous wavesrv or Electron instance is still alive. Run:
```sh
task dev:reset       # kill stragglers + clear locks
task dev:fresh       # reset + relaunch in one shot
```

**Tools say "no rpc for route id feblock:..."**
The block's frontend handler isn't registered, usually because the tab's
websocket disconnected (sleep, HMR, network glitch). Close and reopen the
block, or refresh the tab.

**Foundry bridge logs `[crowe-terminal-tools] catalog probe failed`**
Either `CROWE_AGENT_TOOLS=1` is unset in the bridge's env, or the bridge
spawned with the wrong `WAVETERM_AUTH_KEY`. Restart Crowe Terminal — the
Electron main process generates a fresh key per launch and passes it to
both wavesrv and the bridge.

---

## Where the code lives

```
pkg/agent/
  registry/                   tool registry core
  events/                     lifecycle event hub
  mcpclient/                  outbound MCP stdio client
  transport/
    agenthttp/                HTTP/WS adapter (Foundry-facing)
    waveadapter/              Wave aiusechat ToolDefinition wrappers
    agentmcp/                 MCP server (Claude Desktop / Cursor-facing)
  tools/
    system/                   metrics, applescript, tell_app
    terminal/                 exec_safe, propose_command, list_blocks
    web/                      browser.in_window.*  (12 tools)
    allowlist/                check, list, add
    applescript/              run_applescript, tell_app
    playwright/               opt-in Playwright MCP proxy
    fsmcp/, fetchmcp/, githubmcp/   opt-in MCP proxies
    mcpproxy/                 reusable harness for any future outbound MCP

cmd/
  crowe-mcp/                  standalone MCP server binary
  test-agent/                 standalone harness for verification

docs/agent/
  agentic-orchestrator.md     architecture spec
  USER_GUIDE.md               this file
```

External: `tools/crowe_terminal.py` in the
[crowe-logic-foundry](https://github.com/MichaelCrowe11/crowe-logic-foundry)
repo registers the catalog as Foundry tools.
