<p align="center">
  <picture>
    <img alt="Hypheus" src="./frontend/app/asset/logo.png" width="180">
  </picture>
</p>

<h1 align="center">Hypheus</h1>

<p align="center">
  <strong>A multi-pane terminal where your shell, browser, files, and a CroweLM operator panel branch from one root.</strong><br/>
  A surface of the Crowe Logic platform.<br/>
  macOS · Linux · Windows
</p>

<p align="center">
  <a href="https://hypheus.com">hypheus.com</a>
  &nbsp;·&nbsp;
  <a href="https://crowelogic.com">crowelogic.com</a>
</p>

---

## What is this?

Hypheus is a terminal built around blocks: split panes, an embedded browser, SSH
sessions, a file tree, and a CroweLM operator panel, all in one dynamic layout.
It is wired to the [Crowe Logic Foundry](https://github.com/MichaelCrowe11/crowe-logic-foundry)
agent, which runs on your machine.

Out of the box you get:

- **Five CroweLM models** in the operator panel: Auto (router), Supreme (flagship
  reasoning), Apex (peak performance), Titan (long-context), Oracle (deep foresight)
- **Local agent bridge**, so the Foundry agent runs locally behind an
  OpenAI-compatible API at `127.0.0.1:8011`. Your code stays on your machine;
  only model calls leave it
- **The block foundation**: split panes, browser block, SSH sessions, themes,
  dynamic layout

## Install (macOS)

Releases are signed with `Developer ID Application: Michael Crowe (6QLMV9UCPP)`
and notarized by Apple, so the disk image opens without a Gatekeeper bypass.

Current release, macOS Apple Silicon:

```text
https://releases.hypheus.com/hypheus/Hypheus-darwin-arm64-0.15.5.dmg
```

Current release, macOS Intel:

```text
https://releases.hypheus.com/hypheus/Hypheus-darwin-x64-0.15.5.dmg
```

Open the disk image, drag **Hypheus** to **Applications**, and launch it.

Builds are published to `releases.hypheus.com`, not to GitHub releases. The
releases listed on this repository are from the earlier Crowe Terminal line and
carry higher version numbers than the current Hypheus builds; ignore them.

## How the agent works

Hypheus expects to find the [Foundry repo](https://github.com/MichaelCrowe11/crowe-logic-foundry)
on your machine. On launch it:

1. Probes `127.0.0.1:8011` and reuses the bridge if one is already running
2. Otherwise looks for the foundry at `$CROWE_FOUNDRY_PATH` or `~/Projects/crowe-logic-foundry`
3. Spawns `python -m cli.openai_bridge` with the foundry's venv if found
4. Skips silently if no foundry is present, leaving manual model config working

Set up the Foundry locally. The Foundry repository is private, so the clone below
only works once your GitHub account has been granted access:

```bash
git clone https://github.com/MichaelCrowe11/crowe-logic-foundry ~/Projects/crowe-logic-foundry
cd ~/Projects/crowe-logic-foundry
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Restart Hypheus and the operator panel will show CroweLM models.

## The agent tool surface

CroweLM has a native operator tool surface inside your Hypheus window:

- **`system.*`**: `metrics` (CPU, RAM, processes), `run_applescript`, `tell_app`
  (macOS UI automation)
- **`terminal.*`**: `exec_safe` (read-only commands), `propose_command`
  (mutating commands typed into a visible terminal block, awaiting Enter),
  `list_blocks`, and `read_scrollback`
- **`widget.*`**: `capture_screenshot`, `focus`, and `open_in_crowecode`
  for direct control of visible blocks
- **`vcs.*`**: `checkpoint`, `undo`, `init`, `status`, `diff`, and `history` —
  Jujutsu-backed restore points that make the agent's edits reversible, in a
  local repository with no remote (requires `jj`)
- **`browser.in_window.*`**: `navigate`, `read`, `click`, `type`, `screenshot`,
  `eval`, `wait_for`, `scroll`, `hover`, `get_attr`, `select_option`,
  `list_links`, which drive the in-window webview block
- **`allowlist.*`**: `check`, `list`, `add` patterns that skip the approval gate

Plus four opt-in outbound MCP families. Set the env var and restart:

| Env var | Adds |
|---|---|
| `CROWE_AGENT_PLAYWRIGHT=1` | Full headless Playwright as `browser.*` |
| `CROWE_AGENT_FS=1` + `CROWE_AGENT_FS_ROOTS=...` | Filesystem MCP as `fs.*` |
| `CROWE_AGENT_FETCH=1` | HTTP fetch MCP as `fetch.*` |
| `CROWE_AGENT_GITHUB=1` + `GITHUB_PERSONAL_ACCESS_TOKEN=...` | GitHub MCP as `github.*` |

The same registry is exposed through the standalone `crowe-mcp` binary, so
Claude Desktop, Cursor, or any MCP-aware client can use the same tools.

Full reference and safety model: **[docs/agent/USER_GUIDE.md](./docs/agent/USER_GUIDE.md)**.

## Pricing

The terminal itself is Apache 2.0. Fork it, redistribute it, do what you want.

The Crowe Logic agent behind it is a paid service. Current tiers are listed at
[crowelogic.com/pricing](https://crowelogic.com/pricing).

## Portfolio integration (optional)

If you also run [`crowe-portfolio`](https://github.com/MichaelCrowe11/crowe-portfolio),
the unified knowledge plane across your repos, Hypheus passes two env vars
through to the Foundry bridge:

```bash
export CROWE_PORTFOLIO_URL=https://your-portfolio-host
export CROWE_PORTFOLIO_TOKEN=<bearer>
```

The bridge then exposes `search_code` to the agent, so you can ask
portfolio-wide questions such as *"find every Stripe webhook handler across my
repos"* and get ranked code citations.

## Build from source

```bash
brew install go go-task
git clone https://github.com/MichaelCrowe11/crowe-terminal
cd crowe-terminal
npm install
task package
```

Output: `make/Hypheus-darwin-{arch}-{version}.dmg`

## Acknowledgments

Hypheus builds on [Wave Terminal](https://github.com/wavetermdev/waveterm) by
Command Line Inc. (Apache 2.0). The terminal core, layout system, and SSH and
browser blocks are upstream Wave; the Crowe Logic agent integration, branding,
and themes are this fork's contribution. See [`NOTICE`](./NOTICE) for full
attribution.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
