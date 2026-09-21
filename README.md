# Hypheus (crowe-terminal)

Hypheus is our fork of Wave Terminal: a multi-pane terminal whose side panel lets CroweLM language models drive the shell, browser, and files through tools you approve, shipped for macOS.

## Status

Release validation completed for the agreed macOS smoke scope on 2026-09-21. The signed `418622bc` build passed default CroweLM, exact-`pwd` approval and execution, viewport/composer checks, browser navigation, and opt-in MCP startup. Ready for final packaging and release review; do not tag or publish yet.

Version 0.15.7 (`package.json`). On 2026-09-20, [Build Helper run 35526236572](https://github.com/MichaelCrowe11/crowe-terminal/actions/runs/35526236572) passed on commit `7fb93dd4` for macOS, Linux x64, Linux arm64, and Windows x64. It was a manual validation run, not a release. Its artifacts still identify as 0.15.7 but are newer than the published `v0.15.7` assets; do not treat them as identical builds.

The following table records the original `7fb93dd4` run; the `418622bc` follow-up below supersedes its terminal result.

| Platform | Build evidence on 2026-09-20 | Runtime verification | Distribution / signing |
| --- | --- | --- | --- |
| macOS arm64 | DMG and ZIP built on `macos-26-arm64` | macOS 26.5.1 (25F80), Electron 41.10.7: launch, onboarding, browser navigation, and opt-in Playwright MCP startup passed; CroweLM recovered after three HTTP 429 attempts and returned the expected response; approved exact `pwd` call failed with `block not found` after arguments were inspected through the app's read-only chat endpoint | CI DMG and extracted ZIP app passed local signature/Gatekeeper checks; DMG notarization ticket valid. Public release remains the older `v0.15.7`. |
| macOS x64 | DMG and ZIP built on `macos-26-arm64` | Not launched on Intel or under emulation | CI signing passed; downloaded DMG integrity, signature, stapled ticket, and Gatekeeper checks passed. |
| Linux x64 | ZIP, DEB, RPM, Snap, AppImage, pacman built on Ubuntu 24.04 | Install and app launch not tested | CI artifacts only for this revision; no current Linux GitHub release. |
| Linux arm64 | Same six formats built on Ubuntu 24.04 ARM64 | Install and app launch not tested | CI artifacts only for this revision; no current Linux GitHub release. |
| Windows x64 | NSIS EXE, MSI, ZIP built on `windows-2025-vs2026` | Install and app launch not tested | CI artifacts only; downloaded installer EXE and app EXE have no Authenticode signature. |
| Windows arm64 | Native target excluded from CI | x64 emulation not tested | No native artifact or verified ARM support. |

Follow-up validation covers exact command/target previews, scoped terminal approval, and narrow chat layout: 117 frontend tests, 48 full-panel browser cases, and 15 overflow cases passed. [Build Helper run 35553768975](https://github.com/MichaelCrowe11/crowe-terminal/actions/runs/35553768975) passed all four platforms on commit `418622bc`; the new arm64 macOS artifact passed local signature/notarization/Gatekeeper checks. After renderer/prompt harness corrections, its signed-app terminal subgate passed with a visible canonical `pwd` proposal, approved typing without Enter, separate verified Enter, and exact cwd output. A subsequent fresh run passed the entire smoke after a browser-viewport harness correction, including same-block `https://example.com/` navigation and registration of 25 Playwright MCP tools without invoking them. Viewport/composer checks passed at 1280/1000/800px; the chat pane stayed 458px wide, so this is not signed-app 320/450/720px pane-resize coverage. Nine inert harness tests pass. See [release validation evidence](docs/release-validation-2026-09-20.md) for scope, checks, and remaining release gates.

## Install and first run

Prebuilt, macOS. These two files answered HTTP 200 on 2026-09-10, and `latest-mac.yml` on the same host reports `version: 0.15.7`:

```
https://releases.hypheus.com/hypheus/Hypheus-darwin-arm64-0.15.7.dmg
https://releases.hypheus.com/hypheus/Hypheus-darwin-x64-0.15.7.dmg
```

The same files are attached to the [GitHub release `v0.15.7`](https://github.com/MichaelCrowe11/crowe-terminal/releases/tag/v0.15.7). Open the disk image and drag Hypheus to `/Applications/Hypheus.app`. The 2026-09-20 runtime checks used the newer manual CI artifact, extracted to a temporary directory, not these older published files. GitHub Releases is the distribution channel for a future validated multi-platform release; manual Actions artifacts are validation downloads, not a published release.

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

To build the app itself, `task package` (the `package` task in `Taskfile.yml`) builds the Go server, the frontend, and the Electron bundle through `electron-builder.config.cjs`. The 2026-09-20 manual CI run successfully executed `task package` on all four runners. Local source packaging, `task electron:dev`, and `go test` were not run in that validation; the local runtime test used the signed CI ZIP artifact.

## What runs today

Each item names where it lives.

- The Wave Terminal base: split panes, terminal blocks, an in-window browser block, SSH, a file viewer, themes. Upstream code under `pkg/`, `frontend/`, `emain/`, `cmd/wsh`. Not our work; see Credit.
- A side panel with CroweLM modes defined in `pkg/wconfig/defaultconfig/waveai.json`: Deep Work, Grow Ops (model `crowelm-grower`), Cultivation Research, and a `crowelm-flash` entry, shown by `frontend/app/aipanel/crowechannelpanel.tsx`. Their endpoint is `https://models.crowelogic.com/v1/chat/completions`, checked by `pkg/wconfig/waveai_defaults_test.go`.
- A local mode that talks to `http://127.0.0.1:8011/v1/chat/completions` (`pkg/aiusechat/usechat-mode.go`). `emain/emain-foundry-bridge.ts` looks for a `crowe-logic-foundry` checkout at `CROWE_FOUNDRY_PATH`, `~/Projects/crowe-logic-foundry`, or `~/crowe-logic-foundry` and starts `cli/openai_bridge.py` from it; it passes `CROWE_PORTFOLIO_URL` and `CROWE_PORTFOLIO_TOKEN` through if set. That repo is private and separate.
- Tools the model can call, all present as string names in `pkg/` and `cmd/`: `system.metrics`, `system.run_applescript`, `system.tell_app`; `terminal.exec_safe`, `terminal.propose_command`, `terminal.list_blocks`, `terminal.read_scrollback`; `widget.capture_screenshot`, `widget.focus`, `widget.open_in_crowecode`; `vcs.checkpoint`, `vcs.undo`, `vcs.init`, `vcs.status`, `vcs.diff`, `vcs.history` (backed by Jujutsu through `pkg/jj`, needs `jj` on the machine); twelve `browser.in_window.*` tools (`navigate`, `read`, `click`, `type`, `screenshot`, `eval`, `wait_for`, `scroll`, `hover`, `get_attr`, `select_option`, `list_links`); `allowlist.check`, `allowlist.list`, `allowlist.add`.
- Opt-in MCP tool families switched on by `CROWE_AGENT_PLAYWRIGHT`, `CROWE_AGENT_FS` with `CROWE_AGENT_FS_ROOTS`, `CROWE_AGENT_FETCH`, and `CROWE_AGENT_GITHUB`. On 2026-09-20, Playwright MCP startup and tool registration passed with an explicit isolated command; the other families were not exercised.
- `cmd/crowe-mcp`, a standalone MCP server over the same tool registry. It built and started in the historical 2026-09-10 check (output above); it was not retested on 2026-09-20.
- A dock panel that reads `http://127.0.0.1:8011/crowe/telemetry/stream` (`frontend/app/dock/telemetry-model.ts`).
- Also under `cmd/`: `crowe-farm` and `crowe-farm-sensorpush`, with `install:*` tasks in `Taskfile.yml`. Not built or run today.
- The guide for the panel and its tools: `docs/agent/USER_GUIDE.md`.

## Roadmap

`ROADMAP.md` in this repo is upstream Wave Terminal's roadmap, not ours. The default CroweLM response, signed-app approved terminal action, viewport/composer, browser, and MCP startup checks have passed. Stop for final packaging and release review; no version bump, tag, or publication is authorized. Current Linux and Windows packages build in CI but have not been published; their runtime limitations remain as stated above.

## Limits

This is a fork. The terminal, layout, browser block, SSH, and file viewer are Wave Terminal's work, and the Go module path is still `github.com/wavetermdev/waveterm`. Our part is the CroweLM panel, the tool surface, the bridge to the foundry, branding, and themes. The point at which we forked is not recorded in this repo.

The CroweLM modes call `models.crowelogic.com`, a Crowe Logic service outside this repo. Without it, or without a local bridge on port 8011, the panel has nothing to talk to. Whether and how that service is billed is not in this code, so this README does not say.

The model can run commands, click in the browser block, and, on macOS, drive other apps through AppleScript when the tools allow it. `terminal.propose_command` types a command into a visible block and waits for you to press Enter, and `allowlist.*` can skip the approval gate for patterns you add. These gates are tested only by this repo's own tests. No outside security review has been done. Do not run it against a machine or repository you cannot afford to have changed.

Platforms. The support matrix above distinguishes successful builds from runtime tests. The public GitHub release `v0.15.7`, rechecked on 2026-09-20, contains macOS assets only. The 2026-09-10 release-host check found macOS 0.15.7, a stale Linux 0.1.0 AppImage, and no Windows feed; that host was not rechecked during this validation. S3 staging/publishing remains conditional on `ENABLE_S3_STAGING`; this validation did not enable it or update the generic auto-update feed.

Signing. The 2026-09-20 CI macOS artifacts passed Developer ID, hardened-runtime, notarization, and Gatekeeper checks. This does not retroactively verify older public artifacts. Local builds without signing credentials remain ad-hoc. Windows manual builds are unsigned; enabling signing for a tagged build requires separate verification. Store packaging was skipped and is not verified.

Original `7fb93dd4` runtime limits (the follow-up result above supersedes its terminal failure). The default CroweLM request failed on three attempts with upstream HTTP 429 on 2026-09-20, then returned exactly `HYPHEUS_SMOKE_OK` on the fourth attempt around 21:40 UTC without local app, routing, or quota changes. A subsequent request reached the terminal approval card, but the card showed only a generic tool description, not the proposed command. On a subsequent run, the harness inspected exact `pwd` arguments through the app's read-only chat endpoint, then clicked Approve. The call failed with `block not found: b248deda`; nothing was typed and Enter was not pressed. App and edge source inspection preserve an explicit 4,096-token output budget; the upstream 10,000,000 tokens/minute figure describes the rate-limit tier, not the requested budget. The cause of the upstream rate limiting remains unverified. The browser block navigated to `https://example.com/` and returned its title/body, although the captured narrow pane clipped the page. Playwright MCP 0.0.82 initialized and registered 25 tools with explicit headless/isolated settings; browser-tool execution, the other MCP families, and standalone `crowe-mcp` were not tested in this run. Also unverified: local source packaging, `go test`, Intel/Linux/Windows runtime and installer behavior, sign-in/billing, automatic updates, and `jj`.

## Credit

Hypheus builds on Wave Terminal by Command Line Inc., Apache License 2.0: https://github.com/wavetermdev/waveterm. `NOTICE` carries the attribution, and `ACKNOWLEDGEMENTS.md`, `BUILD.md`, `RELEASES.md`, `CONTRIBUTING.md`, and `ROADMAP.md` are upstream documents kept as they were; the release steps in `RELEASES.md` describe upstream's pipeline, not ours.

## License and contact

Apache License 2.0. `LICENSE` is the Apache 2.0 text, `package.json` says `Apache-2.0`, and `NOTICE` states that our modifications are under the same license.

Contact: michael@crowelogic.com
