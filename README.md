# Hypheus (crowe-terminal)

Hypheus is our fork of Wave Terminal: a multi-pane terminal whose side panel lets CroweLM language models drive the shell, browser, and files through tools you approve, shipped for macOS.

## Status

working

Version 0.15.7 (`package.json`). macOS builds for Apple Silicon and Intel are on the release feed and on the GitHub release `v0.15.7` (published 2026-09-05). The Linux feed holds one AppImage at 0.1.0, far behind the macOS line. No Windows build has been published. Details under Limits.

## Install and first run

Prebuilt, macOS. These two files answered HTTP 200 on 2026-09-10, and `latest-mac.yml` on the same host reports `version: 0.15.7`:

```
https://releases.hypheus.com/hypheus/Hypheus-darwin-arm64-0.15.7.dmg
https://releases.hypheus.com/hypheus/Hypheus-darwin-x64-0.15.7.dmg
```

The same files are attached to the GitHub release `v0.15.7`. Open the disk image and drag Hypheus to Applications. We did not download or launch the disk image for this README.

From source, run on 2026-09-10 in a fresh clone on macOS (arm64). Output is copied from the run.

```
$ node --version
v26.5.0

$ go version
go version go1.25.6 darwin/arm64

$ task --version
3.51.1

$ npm install --no-audit --no-fund
added 2341 packages in 48s

$ go vet ./pkg/...
(no output, exit 0, 24 seconds)

$ go build -o /tmp/ct-bin/ ./cmd/wsh ./cmd/crowe-mcp
(no output, exit 0)

$ /tmp/ct-bin/wsh version
wsh v0.0.0

$ /tmp/ct-bin/crowe-mcp
[crowe-mcp] 2026/09/10 20:57:52 ready: Crowe Agent MCP server (protocol 2024-11-05)

$ npx vitest run
 Test Files  17 passed (17)
      Tests  72 passed (72)
     Errors  6 errors
```

Two things about that run. `wsh version` prints `v0.0.0` in a plain `go build`; the release build stamps the version with `-ldflags` (see `pkg/wavebase/wavebase.go` and `Taskfile.yml`). The six vitest errors are all one message, `Electron failed to install correctly`, because this machine's npm policy skipped Electron's install script (`npm warn allow-scripts`), and vitest exited 1 for that reason. All 72 tests passed.

To build the app itself, `task package` (the `package` task in `Taskfile.yml`) builds the Go server, the frontend, and the Electron bundle through `electron-builder.config.cjs`. We did not run `task package`, `task electron:dev`, or any `go test` today.

## What runs today

Each item names where it lives.

- The Wave Terminal base: split panes, terminal blocks, an in-window browser block, SSH, a file viewer, themes. Upstream code under `pkg/`, `frontend/`, `emain/`, `cmd/wsh`. Not our work; see Credit.
- A side panel with CroweLM modes defined in `pkg/wconfig/defaultconfig/waveai.json`: Deep Work, Grow Ops (model `crowelm-grower`), Cultivation Research, and a `crowelm-flash` entry, shown by `frontend/app/aipanel/crowechannelpanel.tsx`. Their endpoint is `https://models.crowelogic.com/v1/chat/completions`, checked by `pkg/wconfig/waveai_defaults_test.go`.
- A local mode that talks to `http://127.0.0.1:8011/v1/chat/completions` (`pkg/aiusechat/usechat-mode.go`). `emain/emain-foundry-bridge.ts` looks for a `crowe-logic-foundry` checkout at `CROWE_FOUNDRY_PATH`, `~/Projects/crowe-logic-foundry`, or `~/crowe-logic-foundry` and starts `cli/openai_bridge.py` from it; it passes `CROWE_PORTFOLIO_URL` and `CROWE_PORTFOLIO_TOKEN` through if set. That repo is private and separate.
- Tools the model can call, all present as string names in `pkg/` and `cmd/`: `system.metrics`, `system.run_applescript`, `system.tell_app`; `terminal.exec_safe`, `terminal.propose_command`, `terminal.list_blocks`, `terminal.read_scrollback`; `widget.capture_screenshot`, `widget.focus`, `widget.open_in_crowecode`; `vcs.checkpoint`, `vcs.undo`, `vcs.init`, `vcs.status`, `vcs.diff`, `vcs.history` (backed by Jujutsu through `pkg/jj`, needs `jj` on the machine); twelve `browser.in_window.*` tools (`navigate`, `read`, `click`, `type`, `screenshot`, `eval`, `wait_for`, `scroll`, `hover`, `get_attr`, `select_option`, `list_links`); `allowlist.check`, `allowlist.list`, `allowlist.add`.
- Opt-in MCP tool families switched on by `CROWE_AGENT_PLAYWRIGHT`, `CROWE_AGENT_FS` with `CROWE_AGENT_FS_ROOTS`, `CROWE_AGENT_FETCH`, and `CROWE_AGENT_GITHUB`. The names are in the code; we did not exercise them today.
- `cmd/crowe-mcp`, a standalone MCP server over the same tool registry. It built and started today (output above).
- A dock panel that reads `http://127.0.0.1:8011/crowe/telemetry/stream` (`frontend/app/dock/telemetry-model.ts`).
- Also under `cmd/`: `crowe-farm` and `crowe-farm-sensorpush`, with `install:*` tasks in `Taskfile.yml`. Not built or run today.
- The guide for the panel and its tools: `docs/agent/USER_GUIDE.md`.

## Roadmap

Not built. `ROADMAP.md` in this repo is upstream Wave Terminal's roadmap, not ours. We keep no separate roadmap file here. Two gaps we can name from today's checks: a Windows build, and a Linux build on the current version line.

## Limits

This is a fork. The terminal, layout, browser block, SSH, and file viewer are Wave Terminal's work, and the Go module path is still `github.com/wavetermdev/waveterm`. Our part is the CroweLM panel, the tool surface, the bridge to the foundry, branding, and themes. The point at which we forked is not recorded in this repo.

The CroweLM modes call `models.crowelogic.com`, a Crowe Logic service outside this repo. Without it, or without a local bridge on port 8011, the panel has nothing to talk to. Whether and how that service is billed is not in this code, so this README does not say.

The model can run commands, click in the browser block, and, on macOS, drive other apps through AppleScript when the tools allow it. `terminal.propose_command` types a command into a visible block and waits for you to press Enter, and `allowlist.*` can skip the approval gate for patterns you add. These gates are tested only by this repo's own tests. No outside security review has been done. Do not run it against a machine or repository you cannot afford to have changed.

Platforms. `electron-builder.config.cjs` lists macOS, Linux (zip, deb, rpm, snap, AppImage, pacman), and Windows (nsis, msi, zip) targets. Today the release host serves macOS at 0.15.7, Linux at 0.1.0 (one AppImage, `latest-linux.yml`), and nothing for Windows (`latest.yml` returns 404). The GitHub Actions `Build Helper` run for `v0.15.7` failed after 5 seconds on 2026-08-28, so the published builds came from a local `task package`, not from CI.

Signing. The build config signs and notarizes the macOS app only when a certificate and notary credentials are present in the environment, and falls back to an ad-hoc signature otherwise. We did not download the published disk image to check its signature today.

Not verified today: launching the app, `task package`, `go test`, any Linux or Windows build, the MCP families, sign-in or billing behaviour of the edge, and `jj` on this machine.

## Credit

Hypheus builds on Wave Terminal by Command Line Inc., Apache License 2.0: https://github.com/wavetermdev/waveterm. `NOTICE` carries the attribution, and `ACKNOWLEDGEMENTS.md`, `BUILD.md`, `RELEASES.md`, `CONTRIBUTING.md`, and `ROADMAP.md` are upstream documents kept as they were; the release steps in `RELEASES.md` describe upstream's pipeline, not ours.

## License and contact

Apache License 2.0. `LICENSE` is the Apache 2.0 text, `package.json` says `Apache-2.0`, and `NOTICE` states that our modifications are under the same license.

Contact: michael@crowelogic.com
