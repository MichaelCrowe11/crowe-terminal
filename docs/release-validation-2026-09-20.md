# Release validation: 2026-09-20

## Decision

**Do not cut or publish a follow-up release yet.** Build validation passed. After three HTTP 429 failures, the fourth unchanged-default CroweLM attempt returned exactly `HYPHEUS_SMOKE_OK` around 21:40 UTC. The next request reached a terminal approval card, but it did not display the proposed command arguments. On a fifth run, the harness verified exact `pwd` arguments through the app's existing read-only chat endpoint before clicking Approve. The tool then failed with `block not found: b248deda`; no command was typed and Enter was not pressed. The approved terminal-action gate remains failed. Passing the actual approval smoke makes the release eligible for final packaging and release review, not automatic publication. No version bump, tag, release publication, or distribution-host change was made.

## Follow-up implementation in progress

The subsequent end-to-end implementation is authorized to commit reviewed fixes on `release/validate-0.15.7`, push that branch, and manually dispatch Build Helper. The user also authorized exactly `pwd` in a fresh test profile, with separate verified typing and Enter phases bound to the same canonical terminal and tool call. These permissions do not authorize a tag, release, update-feed change, or another terminal command.

The missing image-optimizer dependency is now declared directly: Sharp 0.34.5. It resolves from `vite-plugin-image-optimizer` and passed an in-memory PNG conversion. A local production frontend build exited 0 and successfully optimized all four PNGs, replacing the earlier missing-Sharp diagnostics. Node module-registration deprecation and the `cytoscape`/`mermaid` circular-chunk diagnostic remain. The lockfile adds only Sharp's dependency/platform packages and the root declaration; no existing package versions were changed. Installation used the installed npm 11.17.0 after execution of registry-provided npm 10.9.2 was denied; CI's fresh install will provide the cross-environment check.

Both local frontend builds (`npm run build:dev` and `npm run build:prod`) subsequently passed with all four PNGs optimized, followed by a passing TypeScript check. The frontend suite initially passed 99 tests in 18 files, including 27 new approval tests. After the independent-review corrections, it passed 116 tests in 18 files, including 44 approval tests; TypeScript and `git diff --check` also passed. Independent review and full-panel browser validation are separate gates and are not implied by these unit/build results.

All runtime/build evidence below still refers to the original manual CI commit unless explicitly superseded by a new artifact result. Terminal repair, full-panel regression, and independent source review are complete; final backend suites passed with the race detector and two repetitions. New CI packaging and a new-artifact smoke remain pending. The old signed binary is not evidence for the new source changes.

## Revision and build provenance

- Source: `7fb93dd4a5ccf5b65d2dcc9a843c57d836bd8f24`.
- Version embedded in these validation artifacts: `0.15.7`.
- [Build Helper run 35526236572](https://github.com/MichaelCrowe11/crowe-terminal/actions/runs/35526236572), manually dispatched on `main`.
- macOS, Linux x64, Linux arm64, Windows x64: all jobs succeeded.
- `build-store` and `create-release`: skipped. Manual dispatch does not create a release.
- These are not the older public `v0.15.7` artifacts. Never identify a tested binary by version alone.

| Actions artifact | Artifact ID | Uploaded archive SHA-256 |
| --- | --- | --- |
| macos-latest | 10610481197 | `a66f5ee8012d2f67821adbaba60013528af1e5ad3b3b336afc661c368cfab0fb` |
| windows-latest | 10610216939 | `2a371a7b0d695200a4c5992a677669752618857a27185193731c0f3070c35bc0` |
| ubuntu-latest | 10610106936 | `4ed7f5750caec2bda67b9ea8d1db71ebe9e5c3e02098053241d76ea5d58db8cf` |
| ubuntu-24.04-arm | 10609702336 | `bfc00fb60bd690e3ce1d34a1a664bb531bc1e95be8d9df9693e6799099453b31` |

Archive digests above are reported by GitHub. Actions artifact retention is finite; these links are not a durable public distribution channel.

## macOS package checks

CI built arm64 and x64 on `macos-26-arm64`, using Electron 41.10.7. Both app bundles passed the CI Developer ID/hardened-runtime checks. Both DMGs were accepted by Apple, stapled, and accepted by Gatekeeper.

Downloaded DMGs independently passed on macOS 26.5.1 (25F80), arm64:

```sh
hdiutil verify <dmg>
codesign --verify --verbose=2 <dmg>
xcrun stapler validate <dmg>
spctl --assess --verbose=2 --type install <dmg>
```

| File | Locally calculated SHA-256 |
| --- | --- |
| Hypheus-darwin-arm64-0.15.7.dmg | `9edf2c93b8c7f89b85f4bfa727b3d90592f88a3984104ef621472e04acc555d1` |
| Hypheus-darwin-x64-0.15.7.dmg | `5ebb21f1e3a81e3b08b64517a73a04e82295edd44d67ce4680b9d76b999faa02` |

The arm64 release ZIP was extracted with `ditto`, preserving executable permissions. Its app passed:

```sh
codesign --verify --deep --strict --verbose=2 <app>
spctl --assess --verbose=2 --type execute <app>
```

Gatekeeper reported `accepted`, `source=Notarized Developer ID`. The app was launched from this extraction, not from `/Applications` and not from a modified/re-signed bundle. The normal macOS install destination is `/Applications/Hypheus.app`; drag-install from the DMG was not exercised. Intel runtime and minimum macOS version compatibility remain untested.

## Local runtime results

Host: macOS 26.5.1 (25F80), Apple Silicon. App runtime: Electron 41.10.7, Chromium 146.0.7680.216, embedded Node 24.18.0. Driver: separately installed `playwright-core` 1.63.0, host Node 26.5.0.

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| Signed packaged app launch | Pass | `app.isPackaged=true`, version 0.15.7, real window rendered; screenshot inspected. |
| Fresh-profile onboarding | Pass | Continued with telemetry disabled, skipped feature tour, reached workspace. |
| Terminal startup | Pass, limited | Visible zsh prompt. No terminal command or approval flow completed. |
| CroweLM default response | **Pass on fourth attempt** | Three attempts at approximately 17:56, 17:58, and 18:04–18:05 UTC returned HTTP 429. At approximately 21:40 UTC the unchanged default returned exactly `HYPHEUS_SMOKE_OK`; screenshot inspected. |
| Approved terminal action | **Fail** | Around 21:46 UTC, exact pending `pwd` arguments were inspected via read-only chat GET and Approve was clicked in the real app. `terminal_propose_command` returned `block not found: b248deda`. No typing or execution occurred; Enter was withheld. The card itself lacked a command preview. |
| Browser block navigation | Pass, limited | Entered `https://example.com/` in the real browser block. Guest webContents returned title `Example Domain` and matching body text; screenshot inspected. Narrow-pane rendering clipped page content; no broader browser layout claim. |
| MCP protocol startup | Pass | Playwright MCP 0.0.82: `initialize` (protocol 2024-11-05), `tools/list` (25), and `ping`. |
| MCP startup inside Hypheus | Pass | Packaged wavesrv log: `[agent-playwright] registered 25 playwright tools`; isolated agent `/healthz` returned `{"ok":true,"service":"crowe-agent"}`. |
| MCP tool execution | Not tested | No external-browser action invoked. Other MCP families and standalone `crowe-mcp` untested. |

The first harness attempt tried to send a follow-up after the model error; the Send control remained disabled and the harness timed out. The next attempt started a new chat, completed browser navigation, and stopped deliberately after the repeated model failure. This is not a successful end-to-end AI/tool test.

### CroweLM rate-limit investigation

The third attempt started at 18:04:19 UTC and stopped deliberately with harness exit code 2 after the same upstream error. Its upstream request ID was `req_011CfF8hHTonysqFmuZJnS3t`. No proposal was approved and no command was executed.

Read-only findings:

- The default panel selects `crowelm-apex` and requests 4,096 output tokens (`pkg/wconfig/defaultconfig/waveai.json`, `pkg/aiusechat/usechat.go`, and `pkg/aiusechat/openaichat/openaichat-convertmessage.go`).
- The separate local edge checkout at `/Users/crowelogic/crowe-models-edge/src/index.js:108–109` maps Apex to Azure Anthropic `claude-fable-5-1`. Lines 391–404 preserve an explicit `max_tokens: 4096`; the 16,384 fallback does not apply. This is checkout evidence, not a verified byte-for-byte comparison with the deployed Worker.
- The upstream error's 10,000,000 output tokens/minute is its reported rate-limit tier, not the app's output budget. No inspected app/edge code inflates this request to that size.
- The edge checkout makes one upstream fetch (lines 682–699), preserves HTTP 429 but drops upstream retry/rate-limit headers (lines 539–560). Neither inspected path provides automatic 429 backoff. Header forwarding and bounded retry would improve handling, but have not been demonstrated to resolve this persistent failure.
- A nonpersisted Cloudflare telemetry query for `crowe-models-edge`, 17:54–18:07 UTC, returned three `/v1/chat/completions` responses with status 429 and 77 `/health` responses with status 200. No successful chat was observed in that window. These are observed log counts, not proof of all traffic to the upstream deployment. Only field discovery and aggregate route/status data were retrieved, not request headers or prompt bodies.
- Several edge model aliases share the Fable deployment. Shared upstream usage or capacity constraints remain possible, not proven. No live upstream quota/reset evidence was obtained.

The investigation did not change app code, deployed edge code, model routing, credentials, or quotas. Following approval to resume, the fourth app run returned the exact requested response around 21:40 UTC. This establishes observed recovery, not a diagnosed or permanently fixed upstream cause. The approval card appeared on the subsequent tool request, but its generic description did not expose the actual command; approval was withheld rather than inferred from the prompt. Independent Astra reasoning calls continued to return HTTP 400 and supplied no assessment.

### Profile and service isolation

Temporary evidence directory used during this run:

```text
/private/tmp/hypheus-release-validation.XeClPU/
```

The test used separate `HOME`, `WAVETERM_HOME`, `WAVETERM_CONFIG_HOME`, `WAVETERM_DATA_HOME`, and Electron `--user-data-dir`. Electron confirmed the temporary userData path, but `app.getPath("home")` still reported the normal macOS account home. This was data-directory isolation, not a security sandbox. Auto-update and telemetry were disabled in the test configuration. Terminal settings used `/bin/zsh -f`.

The test agent listened on `127.0.0.1:18012`, leaving the existing agent on 8012 alone. The app unconditionally probes the existing Foundry bridge at 8011; that probe is not isolated and was not counted as local-bridge validation. No existing service was stopped. Test app shutdown was requested after each attempt.

Playwright MCP startup was explicitly opted in using an absolute command with `--headless --isolated`. The test did not use the default dynamic `npx @playwright/mcp@latest` launch path and did not use an existing browser profile.

Local screenshots, extracted binaries, JSON evidence, and temporary smoke scripts are in the temporary directory above; they are not committed or guaranteed to survive cleanup. A project `/run-skill-generator` guide would make this harness reproducible without rediscovery.

## Source-only chat layout regression

After the signed-app smoke, a separate frontend fix addressed assistant text and tool cards extending past the chat pane. The baseline browser preview reproduced a 450px pane with a 448px transcript viewport and 478px content width. The assistant column's minimum width did not leave room for the avatar and gap. Long unbroken text, code minimum widths, and wide tables exposed additional overflow.

The source fix lets the assistant column shrink, wraps long prose/identifiers, bounds code blocks to their parent, and keeps wide code and tables horizontally scrollable inside their own containers. Fonts and user-bubble styling are unchanged; no blanket transcript clipping was added.

The regression uses the real `AIPanelMessages`, `AIMessage`, and `WaveStreamdown` components in `chat-overflow.preview.tsx`, with static messages and inert approval handlers. Browser checks cover prose/user messages/completed cards, long paths/URLs/inline identifiers/error/progress cards, fenced code, wide tables, and pending approval at 320px, 450px, and 720px. All 15 cases passed with no page errors or transcript overflow; text bounds, local horizontal scrolling, vertical scrolling when needed, and the inert Approve interaction were checked. Before/after screenshots were inspected. This is transcript-only source-preview evidence, not a live model/tool test or a full composer/dock-resize test.

To reproduce from the repository root, with frontend dependencies, Chrome, and `playwright-core` installed:

```sh
npx vite --config frontend/preview/vite.config.ts --host 127.0.0.1 --port 7007
# In another terminal, still at the repository root:
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core node scripts/check-chat-overflow.mjs
```

`PLAYWRIGHT_MODULE` may be omitted if `playwright-core` resolves locally. This validation used the separate temporary smoke-driver installation, not a new project dependency. `BROWSER_EXECUTABLE` can select another Chromium executable; `PREVIEW_URL` and `SCREENSHOT_DIR` override the preview URL and evidence directory. Screenshots and `results.json` default to `/tmp/hypheus-chat-overflow`; this run's final evidence is in `/private/tmp/hypheus-chat-overflow-verified`.

Frontend checks: `npx tsc --noEmit` passed; `npm test -- --run` passed all 72 tests in 17 files. `npm run build:dev` emitted bundles and exited 0, but the image optimizer reported missing `sharp` for four PNGs. It also reported Node module-registration deprecation, Electron `fs`/`path` browser externalization, and a `cytoscape`/`mermaid` circular chunk. This is not a clean packaging/signing result. No dependency or packaging changes were made to address those diagnostics. `git diff --check` passed. Prettier passed for the streamdown renderer and new regression files; `aimessage.tsx` already fails Prettier on `HEAD`, so unrelated whole-file formatting was left unchanged.

**The layout fix is not in the signed CI artifact tested above.** It has not been packaged or published and does not clear the failed terminal-action release gate.

## Full-panel source integration

The follow-up fixture mounts the real `AIPanel`, composer, `useChat`, and transport. Only the global RPC client and HTTP/SSE boundaries are mocked; no live model, backend, or terminal is used. Its 30-case matrix passed at 320px, 450px, and 720px, covering Send/Enter/Shift+Enter, approval/denial, delayed and failed RPCs, abort, invalid/missing previews, consecutive/reordered calls, history, long content, scrolling, and resizing. The updated transcript-only overflow matrix also passed all 15 cases. Screenshots were inspected, including the narrow command/target preview and RPC-error state.

Reproduce this browser matrix with an already-installed `playwright-core` and Chrome:

```sh
npx vite --config frontend/preview/vite.config.ts --host 127.0.0.1 --port 7011
# In another terminal, from the repository root:
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core PREVIEW_URL=http://127.0.0.1:7011 node scripts/check-terminal-approval.mjs
```

These browser scripts are local validation, not steps in Build Helper; a fresh `npm ci` alone does not install their external browser driver. Build Helper gates packaging on focused Go tests, frontend tests/typecheck, and the Sharp conversion probe.

The fixture recorded 15 exact fake typing events and zero executions/newline additions. No unexpected HTTP request, page error, or boundary violation occurred. Vite's expected blocked development-WebSocket diagnostic was filtered; this is not a claim that every console entry was empty. Evidence: `hypheus-terminal-approval-VBNJRL/results.json` and screenshots in the temporary macOS directory, and `/private/tmp/hypheus-overflow-integration.ldGglw`. TypeScript, script syntax, and touched fixture/script formatting passed. The fixture's owned preview server was stopped without touching existing services.

After review fixes, the expanded matrix passed **48/48**, and overflow passed **15/15** again. Added browser cases exercise acknowledged stream completion/Stop/error without false nonapproval, real 10-second RPC timeout and explicit retry without automatic retry, bidi rejection, and stable DOM identity plus keyboard focus across five file-batch membership transitions. The run recorded 27 exact fake typing events, 54 decision attempts including retries, and zero executions, unexpected requests, or page errors. Final screenshots were inspected. Evidence: `hypheus-terminal-approval-rHRWei/results.json` in the temporary macOS directory and `/private/tmp/hypheus-overflow-review.RsE61n`. The fixture waits for the composer's existing deferred post-submit focus before testing batch-focus preservation. Its owned preview server was stopped. This is final source-browser evidence, not a signed-artifact smoke. Review identified a missing approval-RPC deadline, ambiguous bidirectional Unicode preview text, false nonapproval messaging after an acknowledged decision loses its status stream, and unstable file-batch keys. All four were corrected and independently re-verified: a 10-second RPC deadline with unknown-outcome messaging/no automatic retry, matching bidi-control rejection, preserved acknowledged-but-unconfirmed state, and stable batch-category keys. Backend review also found eager validation could break an ordered write-then-read tool batch; unrelated verifiers now retain their per-call timing, with an inert regression test. Only terminal proposals prepare eagerly.

Static smoke-driver review found that a natural-language request and after-the-fact polling cannot enforce the user's exact-`pwd` authorization: widget access otherwise exposes additional tools, including command execution. The implementation now provides `CROWE_TERMINAL_APPROVAL_SMOKE=1`, read at process startup, enforcing a deny-only restriction at backend lookup and dispatch as well as both outgoing tool catalogs. Only terminal listing and approved command proposal remain; provider-native web search is disabled. The driver requires the exact fresh startup marker before sending any model request. Default application behavior is unchanged. Inert env-on tests and independent source review verified the restriction. The driver also reconstructs only xterm-marked soft-wrapped lines before exact cwd comparison. This is a model-tool restriction, not an OS sandbox; live artifact validation remains pending.

The backend's exact-text guarantee binds the prepared preview to the bytes sent. Direct raw terminal transport rejects malformed UTF-8/surrogates before JSON decoding, but provider adapters already decode their arguments and can replace malformed input first. This is not a guarantee that every malformed character in original provider JSON is rejected.

## Follow-up backend and harness checks

Focused Go tests run from the repository root with fake stores, events, input channels, and durable-job sinks. They cover scoped full/prefix resolution, ambiguity and wrong targets, exact bytes and control rejection, immutable preparation, destination/process/job changes, approval publication/cleanup, duplicate decisions, ordered existing-tool verification, and the smoke-only catalog/dispatch restriction. Race-detector runs passed; macOS linker `LC_DYSYMTAB` warnings were emitted. No test invoked a real model or terminal command. Approval IDs are reserved for the backend process lifetime, preventing a stale card from deciding a later request that reuses the same ID. The reservation retains only IDs, not command payloads, and grows with unique approvals until process exit.

```sh
go test ./pkg/agent/tools/terminal ./pkg/agent/transport/waveadapter ./pkg/aiusechat ./pkg/aiusechat/uctypes ./pkg/blockcontroller -run '^Test(TerminalProposal|TerminalApproval|ScreenshotToolExcludedFromWavePath|AppendAgentToolsPreservesExisting)' -count=1 -timeout=90s
CROWE_TERMINAL_APPROVAL_SMOKE=1 go test ./pkg/aiusechat ./pkg/aiusechat/uctypes -run '^TestTerminalApprovalSmoke' -count=1 -timeout=90s
```

The new `scripts/smoke-terminal-approval.cjs` passed syntax checking and independent static review. It requires a newly verified artifact, hash/provenance JSON, explicit `--approve-exact-pwd`, a fresh profile and evidence directory, and the backend tool-restriction marker. Runtime success cannot be inferred from syntax checking. No prior approval marker is reused.

## Linux and Windows evidence

- Ubuntu 24.04 x64 and Ubuntu 24.04 ARM64 successfully built ZIP, DEB, RPM, Snap, AppImage, and pacman packages.
- Windows runner `windows-2025-vs2026` successfully built x64 NSIS EXE, MSI, and ZIP.
- Downloaded Windows MSI metadata identifies Hypheus and `Template: x64;1033`.
- Downloaded NSIS installer EXE and unpacked `Hypheus.exe` have an empty PE security directory, confirming no embedded Authenticode signature. Builder log lines saying `signing with signtool.exe` are not evidence of a signed result.
- No Linux or Windows install, launch, uninstall, or update test was performed. Their install paths and runtime support are not yet verified. Windows ARM64 emulation was not tested; no native ARM64 desktop artifact was built.
- macOS ZIP launch does not establish that Linux/Windows installers work.

## Distribution and remaining gates

The public GitHub `v0.15.7` release was rechecked and contains macOS assets only. Current Linux/Windows validation artifacts exist in Actions but are **not published releases**. No S3 upload was performed; `ENABLE_S3_STAGING` remains the workflow gate for optional staging/publishing. The configured generic update feed was not changed or validated.

Remaining active validation gate:

1. **Passed around 21:40 UTC:** the unchanged default CroweLM response recovered without substituting a model or bypassing authentication. Earlier rate-limit root cause remains undiagnosed.
2. In the actual app, request exactly `pwd` through `terminal.propose_command`, inspect it, click Approve, confirm it is typed without execution, press Enter, and verify output.

Other validation is outside the remaining task; the measured platform limitations above remain explicit rather than being promoted to passes. If both steps pass, stop for final packaging and release review. Do not bump the version, tag, cut, or publish the follow-up release under the current authorization. Any later authorized release review must verify its own artifacts and distribution state; this manual build does not prove tag-only behavior or update-feed publication.

No local `task package`, direct `go build`, or `go run` was run. The original artifact validation did not run local Go tests; the follow-up implementation added focused inert Go tests and ran them from the repository root. New tests use fake stores/events, buffered input channels, and a fake durable-job sink, not real terminal commands. CI exercised `task package` on all four runners for the original artifact. The independent Astra reasoning service returned HTTP 400, so it supplied no review result.
