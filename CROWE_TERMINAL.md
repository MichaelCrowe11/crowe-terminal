# Crowe Terminal

A fork of [Wave Terminal](https://www.waveterm.dev/) (Apache 2.0)
rebranded as the third surface in the Crowe Logic platform alongside
Crowe Code (IDE fork) and the Crowe Logic AI cultivation OS.

## Why Wave, not iTerm2 or Warp

iTerm2 is GPL-licensed and excellent but indistinguishable from every
other premium developer setup. Warp is a competitor's product. Wave
is Apache 2.0, modern multi-pane (terminal + browser + file viewer +
AI), and not yet bundled by any AI coding workstation. Forking it
gives Crowe Logic a differentiated terminal surface that the Cursor /
Windsurf / Claude Code stack does not have.

## What this fork already changes

Phase 1 (shipped in this commit):

| Change | File |
|---|---|
| Package identity rename to crowe-terminal | `package.json` |
| Product name "Crowe Terminal" | `package.json` |
| App bundle id `io.crowelogic.terminal` | `package.json` |
| Diamond mark logo | `frontend/app/asset/logo.svg` |
| macOS app icon (regenerated from diamond) | `build/icon.icns` |
| Crowe Logic Dark + Light terminal themes | `pkg/wconfig/defaultconfig/termthemes.json` |
| README documenting fork posture | `CROWE_TERMINAL.md` (this file) |

The two new terminal themes use the same gold-on-graphite palette as
Crowe Code (`#bfa669` accent, `#0b0b0c` graphite, `#e8e2cf` parchment)
so the IDE and terminal look like they belong to the same platform.

## What still needs to ship for a real release

Phase 2 (next iteration, ~1 day of focused work):

### Branding
- [ ] Replace Linux PNG icons under `build/icons/`
- [ ] Replace Windows `build/icon.ico`
- [ ] Audit user-facing strings for "Wave" references and replace where
      appropriate. Many internal struct names (`wavesrv`, `wsh`) can
      stay since they are not user-visible.
- [ ] Rebrand the welcome / first-run experience
- [ ] Set Crowe Logic Dark as the default terminal theme on first run

### Defaults
- [ ] Default terminal profile invokes the Foundry CLI (`cl-agent` or
      `crowe-logic`). Currently zsh.
- [ ] Default browser pane bookmarks include `crowecode.com` and
      `ai.southwestmushrooms.com`.
- [ ] AI provider config: route Wave's chat pane to the Crowe Logic
      LM gateway instead of Wave's default provider.

### Distribution
- [ ] Bump version reset to `0.1.0` (we are starting our own version
      stream, not continuing Wave's `0.14.x`).
- [ ] Code-sign + notarize macOS .dmg with Crowe Logic, Inc.
      Developer ID. Without notarization, users see a Gatekeeper
      warning on first launch.
- [ ] Publish .dmg / .deb / .exe artifacts to GitHub releases at
      `MichaelCrowe11/crowe-terminal`.
- [ ] Add download links to `crowecode.com` once that domain is live.

### Optional brand polish
- [ ] Custom splash / loading screen with the diamond mark
- [ ] Custom dock icon animation
- [ ] Bundled Crowe Logic font (if licensing permits) for terminal output
- [ ] Brand-consistent error states + toasts

## Build instructions

The upstream `BUILD.md` still applies because the fork is mostly
identity changes, not architectural ones. Quick reference:

```bash
# Install dependencies
npm install

# Run in dev mode (Electron + Vite)
npm run dev

# Build production .dmg / .pkg / .exe / .deb
npm run package
```

The first `npm run package` after the rebrand should produce
`Crowe Terminal-darwin-arm64-0.14.5.dmg` (or similar) at
`dist/`. Bump version to 0.1.0 in `package.json` before the first
release tag.

## Apache 2.0 attribution

This project is a derivative work of Wave Terminal. The Apache 2.0
license requires we preserve attribution. Keep `ACKNOWLEDGEMENTS.md`
and the original `LICENSE` file in place. Add a NOTICE file at the
repo root documenting the fork relationship before releasing.

```
NOTICE
======
Crowe Terminal is a derivative work of Wave Terminal,
originally created by Wave Inc. and licensed under
Apache 2.0. Source: https://github.com/wavetermdev/waveterm

Crowe Terminal modifications copyright (c) 2026 Crowe Logic, Inc.
```

## How this fits the Crowe Logic platform

```
+-------------------- Surfaces ---------------------+
|  Crowe Code (IDE)        Crowe Terminal           |
|  Crowe Research (CLI)    Crowe Studio (content)   |
|  Crowe Logic AI (cultivation OS)                  |
+---------------------------------------------------+
                     |
+--------------- Shared spine ----------------------+
|  Auth + PAT     Billing + Stripe                  |
|  Model gateway  Tool registry                     |
|  Credit ledger  CroweLM                           |
+---------------------------------------------------+
```

Each surface contributes to the platform pitch and the credit ledger
ties them together. Crowe Terminal becomes the place users live when
they shell into a server, browse logs, and hand off to Crowe Logic
chat without leaving the window.

## Trademark / naming caveats

- "Wave" trademark stays with Wave Inc. We do NOT use it in the
  Crowe Terminal product, marketing, or website.
- "Crowe Terminal" is our trademark. File before public release.
- The fork relationship is disclosed in NOTICE; we do not suggest
  endorsement by Wave Inc.

## Status

Phase 1 fork: complete (this commit).
Phase 2 build: not started.
First public release: target two weeks after May 4 IDE launch.
