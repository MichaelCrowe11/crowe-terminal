     <p align="center">
       <picture>
         <img alt="Crowe Terminal" src="./frontend/app/asset/logo.png" width="180">
       </picture>
     </p>

     <h1 align="center">Crowe Terminal</h1>

     <p align="center">
       <strong>The terminal with CroweLM Supreme built in.</strong><br/>
       An AI-native terminal powered by the Crowe Logic Foundry agent.<br/>
       macOS · Linux · Windows
     </p>

     <p align="center">
       <a href="https://github.com/MichaelCrowe11/crowe-terminal/releases/latest"><b>Download for macOS</b></a>
       &nbsp;·&nbsp;
       <a href="https://crowelogic.com">crowelogic.com</a>
     </p>

     <p align="center">
       <em>Crowe Terminal is becoming Crowe Code. v1.0.0 will ship as a separate app and will not auto-update from v0.14.x. Watch <a href="https://www.crowelogic.com">crowelogic.com</a> for the release.</em>
     </p>

     ---

     ## What is this?

     Crowe Terminal is an AI-native terminal from Crowe Logic, wired directly to the [Crowe Logic Foundry](https://github.com/MichaelCrowe11/crowe-logic-foundry) agent.

     Out of the box you get:

     - **Five CroweLM models** in the AI block: Auto (router), Supreme (flagship reasoning), Apex (peak performance), Titan (long-context), Oracle (deep foresight)
     - **Local agent bridge** — the Foundry agent runs on your machine via a local OpenAI-compatible API at `127.0.0.1:8011`. Your code stays local; only model calls leave the machine
     - **Crowe Terminal foundation** — split panes, browser block, SSH sessions, themes, dynamic layout

     ## Install (macOS)

     > Releases are signed with `Developer ID Application: Michael Crowe (6QLMV9UCPP)` and notarized by Apple. The DMG opens cleanly on macOS 10.15 and later.
     >
     > 1. Download the `.dmg` for your CPU from [releases](https://github.com/MichaelCrowe11/crowe-terminal/releases/latest):
     >    - `Crowe.Terminal-darwin-arm64-*.dmg` for Apple Silicon (M1, M2, M3, M4)
     >    - `Crowe.Terminal-darwin-x64-*.dmg` for Intel Macs
     > 2. Open the `.dmg`, drag **Crowe Terminal** to **Applications**.
     > 3. Double-click **Crowe Terminal** in Applications. No Gatekeeper bypass required.

     ## How the agent works

     The terminal expects to find the [Foundry repo](https://github.com/MichaelCrowe11/crowe-logic-foundry) on your machine. On launch it:

     1. Probes `127.0.0.1:8011` — if a bridge is already running, reuses it
     2. Else looks for the foundry at `$CROWE_FOUNDRY_PATH` or `~/Projects/crowe-logic-foundry`
     3. Spawns `python -m cli.openai_bridge` with the foundry's venv if found
     4. Skips silently if no foundry is found — the manual AI config still works

     Set up the Foundry locally:

     ```bash
     git clone https://github.com/MichaelCrowe11/crowe-logic-foundry ~/Projects/crowe-logic-foundry
     cd ~/Projects/crowe-logic-foundry
     python3 -m venv .venv
     .venv/bin/pip install -r requirements.txt
     ```

     Restart Crowe Terminal — the AI block will show CroweLM models.

     ## What CroweLM can do — the agent tool surface

     Out of the box, CroweLM has 21 native tools that operate inside your Crowe
     Terminal window:

     - **`system.*`** — `metrics` (CPU/RAM/processes), `run_applescript`,
       `tell_app` (macOS UI automation)
     - **`terminal.*`** — `exec_safe` (read-only commands), `propose_command`
       (mutating commands typed into a visible terminal block, awaits Enter),
       `list_blocks`
     - **`browser.in_window.*`** — `navigate`, `read`, `click`, `type`,
       `screenshot`, `eval`, `wait_for`, `scroll`, `hover`, `get_attr`,
       `select_option`, `list_links` — drive the in-window webview block
     - **`allowlist.*`** — `check`, `list`, `add` patterns that skip the
       approval gate

     Plus four opt-in outbound MCP families (set the env var, restart):

     | Env var | Adds |
     |---|---|
     | `CROWE_AGENT_PLAYWRIGHT=1` | Full headless Playwright as `browser.*` |
     | `CROWE_AGENT_FS=1` + `CROWE_AGENT_FS_ROOTS=...` | Filesystem MCP as `fs.*` |
     | `CROWE_AGENT_FETCH=1` | HTTP fetch MCP as `fetch.*` |
     | `CROWE_AGENT_GITHUB=1` + `GITHUB_PERSONAL_ACCESS_TOKEN=...` | GitHub MCP as `github.*` |

     The same registry is also exposed via the standalone `crowe-mcp` binary so
     Claude Desktop / Cursor / any MCP-aware client can use the same tools.

     Full reference + safety story: **[docs/agent/USER_GUIDE.md](./docs/agent/USER_GUIDE.md)**.

     ## Pricing

     The terminal is free and open-source (Apache 2.0 — fork it, redistribute it, do what you want).

     The **Crowe Logic agent** behind it follows the [Crowe Logic pricing](https://crowelogic.com/pricing):

     | Tier | Price | What you get |
     |---|---|---|
     | BYOK | $19/mo | Bring your own provider API keys, agent runs locally, full feature set |
     | Personal | $29/mo | Hosted CroweLM Auto/Apex/Titan, 750 credits/mo, no key management |
     | Pro | $99/mo | Adds Supreme/Oracle/Sovereign, unmetered dual-mode, 5h session memory |
     | Team | $49/seat/mo | Pooled credits, shared workspace, admin cost reporting (3+ seats) |

     ## Portfolio integration (optional)

     If you also run [`crowe-portfolio`](https://github.com/MichaelCrowe11/crowe-portfolio) (the unified knowledge plane across all your repos), Crowe Terminal will pass two env vars through to the Foundry bridge:

     ```bash
     export CROWE_PORTFOLIO_URL=https://your-portfolio-host
     export CROWE_PORTFOLIO_TOKEN=<bearer>
     ```

     The bridge then exposes `search_code` to the agent, so you can ask the AI block portfolio-wide questions like *"find every Stripe webhook handler across my repos"* and get ranked code citations across canonical repos.

     ## Build from source

     ```bash
     brew install go go-task
     git clone https://github.com/MichaelCrowe11/crowe-terminal
     cd crowe-terminal
     npm install
     task package
     ```

     Output: `make/Crowe Terminal-darwin-{arch}-{version}.dmg`

     ## Acknowledgments

     Crowe Terminal builds on [Wave Terminal](https://github.com/wavetermdev/waveterm) by Command Line Inc. (Apache 2.0). The terminal core, layout system, and SSH/browser blocks are upstream Wave; the Crowe Logic agent integration, branding, and themes are this fork's contribution. See [`NOTICE`](./NOTICE) for full attribution.

     ## License

     Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
