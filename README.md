<p align="center">
  <picture>
    <img alt="Crowe Terminal" src="./frontend/app/asset/logo.png" width="180">
  </picture>
</p>

<h1 align="center">Crowe Terminal</h1>

<p align="center">
  <strong>The terminal with Claude Opus 4.7 built in.</strong><br/>
  An AI-native terminal powered by the Crowe Logic Foundry agent.<br/>
  macOS · Linux · Windows
</p>

<p align="center">
  <a href="https://github.com/MichaelCrowe11/crowe-terminal/releases/latest"><b>Download for macOS</b></a>
  &nbsp;·&nbsp;
  <a href="https://crowelogic.com">crowelogic.com</a>
</p>

---

## What is this?

Crowe Terminal is a fork of [Wave Terminal](https://www.waveterm.dev) (Apache 2.0) re-skinned with Crowe Logic branding and wired directly to the [Crowe Logic Foundry](https://github.com/MichaelCrowe11/crowe-logic-foundry) agent.

Out of the box you get:

- **Five CroweLM models** in the AI block: Auto (router), Supreme (Claude Opus 4.7), Apex, Titan, Oracle
- **Local agent bridge** — the Foundry agent runs on your machine via a local OpenAI-compatible API at `127.0.0.1:8011`. Your code stays local; only model calls leave the machine
- **Wave's terminal foundation** — split panes, browser block, SSH sessions, themes, dynamic layout

## Install (macOS)

> **Beta:** the .dmg is currently signed ad-hoc. Apple notarization in progress. For now:
> 1. Download the `.dmg` for your CPU (arm64 for M-series, x64 for Intel) from [releases](https://github.com/MichaelCrowe11/crowe-terminal/releases/latest)
> 2. Open it, drag **Crowe Terminal** to **Applications**
> 3. **First launch:** right-click `Crowe Terminal.app` in Finder → **Open** → **Open** in the Gatekeeper dialog. Double-click works after the first time.

## How the agent works

The terminal expects to find the [Foundry repo](https://github.com/MichaelCrowe11/crowe-logic-foundry) on your machine. On launch it:

1. Probes `127.0.0.1:8011` — if a bridge is already running, reuses it
2. Else looks for the foundry at `$CROWE_FOUNDRY_PATH` or `~/Projects/crowe-logic-foundry`
3. Spawns `python -m cli.openai_bridge` with the foundry's venv if found
4. Skips silently if no foundry is found — Wave's manual AI config still works

Set up the Foundry locally:

```bash
git clone https://github.com/MichaelCrowe11/crowe-logic-foundry ~/Projects/crowe-logic-foundry
cd ~/Projects/crowe-logic-foundry
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Restart Crowe Terminal — the AI block will show CroweLM models.

## Pricing

The terminal is free and open-source (Apache 2.0 — fork it, redistribute it, do what you want).

The **Crowe Logic agent** behind it follows the [Crowe Logic pricing](https://crowelogic.com/pricing):

| Tier | Price | What you get |
|---|---|---|
| BYOK | $19/mo | Bring your Anthropic / OpenAI / Azure keys, agent runs locally, full feature set |
| Personal | $29/mo | Hosted CroweLM Auto/Apex/Titan, 750 credits/mo, no key management |
| Pro | $99/mo | Adds Supreme/Oracle/Sovereign, unmetered dual-mode, 5h session memory |
| Team | $49/seat/mo | Pooled credits, shared workspace, admin cost reporting (3+ seats) |

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
