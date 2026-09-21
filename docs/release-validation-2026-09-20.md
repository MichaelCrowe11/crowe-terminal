# Release validation: 2026-09-20

## Decision

**Do not cut or publish a follow-up release yet.** The new signed macOS arm64 artifact from `418622bc` passed the actual terminal-approval subgate on 2026-09-21: unchanged-default CroweLM, exact visible `pwd` proposal/canonical target, approval typing without Enter, separate verified Enter, and exact isolated cwd output with a returned prompt. That first terminal-success run stopped later at browser setup. After a reviewed harness-only viewport correction, a fresh run passed the entire agreed smoke, including viewport/composer checks, same-block example.com navigation, and opt-in MCP startup. Four-platform CI packaging passed. The historical failures below remain evidence, not the current terminal result. Passing validation makes the release eligible for review, not automatic publication. No version bump, tag, release publication, or distribution-host change was made.

## Follow-up implementation and validation

The subsequent end-to-end implementation is authorized to commit reviewed fixes on `release/validate-0.15.7`, push that branch, and manually dispatch Build Helper. The user also authorized exactly `pwd` in a fresh test profile, with separate verified typing and Enter phases bound to the same canonical terminal and tool call. These permissions do not authorize a tag, release, update-feed change, or another terminal command.

The missing image-optimizer dependency is now declared directly: Sharp 0.34.5. It resolves from `vite-plugin-image-optimizer` and passed an in-memory PNG conversion. A local production frontend build exited 0 and successfully optimized all four PNGs, replacing the earlier missing-Sharp diagnostics. Node module-registration deprecation and the `cytoscape`/`mermaid` circular-chunk diagnostic remain. The lockfile adds only Sharp's dependency/platform packages and the root declaration; no existing package versions were changed. Installation used the installed npm 11.17.0 after execution of registry-provided npm 10.9.2 was denied; CI's fresh install will provide the cross-environment check.

Both local frontend builds (`npm run build:dev` and `npm run build:prod`) subsequently passed with all four PNGs optimized, followed by a passing TypeScript check. The frontend suite initially passed 99 tests in 18 files, including 27 new approval tests. After the independent-review corrections, it passed 116 tests in 18 files, including 44 approval tests; TypeScript and `git diff --check` also passed. Independent review and full-panel browser validation are separate gates and are not implied by these unit/build results.

All runtime/build evidence below still refers to the original manual CI commit unless explicitly superseded by a new artifact result. Terminal repair, full-panel regression, and independent source review are complete; final backend suites passed with the race detector and two repetitions. New CI packaging and the complete signed-artifact follow-up smoke subsequently passed as recorded below. The old signed binary is not evidence for the new source changes.

### Follow-up CI attempt

[Build Helper run 35553118190](https://github.com/MichaelCrowe11/crowe-terminal/actions/runs/35553118190) manually tested reviewed commit `e7d47a46a7ac93b102bf2743e5491835a2423e3b` on `release/validate-0.15.7`. Scoped backend tests, restricted-tool dispatch tests, and frontend typechecking passed. All 116 frontend assertions passed, but Vitest correctly failed on an unhandled `fetch failed` rejection attributed to `mcpui.test.tsx` after teardown (`getaddrinfo EAI_AGAIN undefined`). The Sharp probe and all packaging jobs were skipped; no new signed artifact was produced. Store and release jobs were skipped. The test isolation failure must be corrected before a new artifact smoke; the validation gate was not bypassed.

The MCP fixture had started a real WOS object load before seeding its object; seeding did not cancel the pending fetch. It now seeds the existing in-memory WaveEnv store and redirects only the model's global WOS atom lookup to that store. A fail-fast fetch guard and metadata/zero-fetch regression fail deterministically before the fixture correction and pass after it. The local full suite now passes 117 tests in 18 files without unhandled errors; TypeScript, touched-test formatting, smoke-driver syntax, and diff checks pass. No production MCP behavior or CI failure detection was changed.

A separate smoke-driver preflight corrected an assertion contradicted by prior macOS evidence: Electron's native `app.getPath("home")` remains the account home even with explicit `HOME`. The driver now verifies inherited `HOME`, records native home separately as a limitation, and retains independent checks for fresh userData, backend config/data, shell cwd, unique prompt, exact typing, separate Enter, and exact cwd output. Independent review found no weakening of those terminal checks. The later signed `418622bc` runs passed these corrected runtime-identity checks; no app bundle modification was needed.

### New artifact: commit `418622bc`

[Build Helper run 35553768975](https://github.com/MichaelCrowe11/crowe-terminal/actions/runs/35553768975) passed the validation gate and all four platform jobs on `418622bce356d95045ab966d9a5746ba3f368223`. Store and release jobs were skipped. No tag or publication occurred.

| Actions artifact | Artifact ID | GitHub archive SHA-256 |
| --- | --- | --- |
| macos-latest | 10619753314 | `ae0523e00b2e5092ca657ca6270e1f197026972197d1b70527629ac1e213b33f` |
| windows-latest | 10619528594 | `29d67990195bac1c64341754f7c0cdc20d7dad334f53f44c19a1f9c66173fb76` |
| ubuntu-latest | 10619103976 | `7b0b9a2ad4285510a5638ba4eed9c548292fea3f73ff9a35aecd6c8128cdd87f` |
| ubuntu-24.04-arm | 10619008938 | `a791978442b95f00415e5b0c1b53c86d8f17ec11a8225bdfed8471b5046dc467` |

The macOS archive digest was independently verified. Only the arm64 DMG and release ZIP were extracted locally. DMG integrity, signature, stapled notarization ticket, and Gatekeeper passed. The ZIP-extracted arm64 app passed deep/strict signature verification, Developer ID/hardened-runtime inspection, and Gatekeeper (`Notarized Developer ID`). New Linux/Windows and Intel runtime checks were not performed.

Receipts and binary hashes: `/private/tmp/hypheus-validation-418622bc-1hy08p0g/{build-final.json,artifacts.json,verification.json,provenance.json}`. The first launch attempt using the correct artifact path reached verified packaged runtime identity but failed before any model request: the harness attempted a screenshot of a zero-width page. No command approval or Enter occurred; owned-process cleanup recorded zero survivors. Evidence: `hypheus-terminal-approval-0UZvk3/result.json` and `cleanup.json` under that directory. An earlier CLI invocation contained a path typo and failed before app launch. Neither attempt is a terminal-action pass.

A reviewed harness-only change now selects the visible, initialized native tab renderer with matching packaged URL and window/tab IDs, instead of the first Playwright page. The next attempt (`hypheus-terminal-approval-LjdEMi`) passed renderer readiness and produced an inspected app screenshot, but stopped at the exact initial prompt/cursor check before any model request. The visible random prompt matched the configured label; visual similarity alone was not accepted as terminal-state evidence. Cleanup again recorded zero survivors. A bounded exact-prompt wait and pre-assertion observations were added because shell OSC readiness precedes prompt rendering. The following attempt (`hypheus-terminal-approval-ilxDwi`) still timed out before model use. Its structured evidence identified the actual comparison defect: the cursor was exactly at column 18 and xterm retained the explicitly printed trailing prompt space, while the harness compared against a trimmed expected string. The corrected assertion compares the complete physical row against the exact ASCII prompt/command padded to the terminal width, with the exact cursor column and blank rows below. Nine inert harness tests pass, covering trailing-space representation, typed `pwd`, altered cursor/input, row coverage, wrap rejection, and logical cwd output reconstruction. Independent review caught that physical padding alone would accept an extra explicit trailing space followed by cursor reset; the final assertion also checks xterm's trimmed-row representation, and regressions reject that case for both the empty prompt and typed command. The actual captured failing initial prompt also passes this corrected assertion, while an altered cursor fails. These are harness checks, not a terminal-action pass.

### Signed terminal subgate passed; first full run stopped at browser

Run `8c8bb517-f39d-4263-8bf8-a55b3aa74db9`, evidence `hypheus-terminal-approval-Zd7Mic` under the new artifact directory, ran from 2026-09-21 03:07:34–03:07:57 UTC. Its terminal subgate passed, but `result.json` correctly reports **failed**, phase `browser-example`, error `Expected one existing browser URL field`.

- Unchanged `waveai@crowelm-auto` returned exactly `HYPHEUS_SMOKE_OK`.
- Call `toolu_01RZWoAqdb3uYm66Ygg9tSKJ` proposed exactly `pwd` for local terminal `ccb5323d-020d-4f63-a11a-78fb5012efed`, tab `3dd9b6e7-349b-49e1-b6e9-5ccb171dbb76`. The visible command, full canonical target, raw arguments, and prepared metadata matched before approval.
- `typed-not-executed.json` records exact `pwd` at the prompt, no executed command, and a successful tool result with `awaits: user_enter`. A distinct `authorization-enter.json` preceded the one Enter input.
- `pwd-result.json` records exactly `/private/tmp/hypheus-validation-418622bc-1hy08p0g/hypheus-terminal-approval-Zd7Mic/home`, reconstructed only across xterm-marked soft wraps, and one new ready prompt. Pending/typed/executed screenshots were inspected.
- Renderer viewport widths 1280/1000/800 passed multiline-composer containment and panel horizontal-overflow checks. The AI pane remained 458px wide; this is not signed-artifact 320/450/720px pane-resize coverage.
- The 800px screenshot showed collapsed browser header controls. The driver now restores the original renderer viewport before finding the existing same-tab browser by canonical block UUID and navigating through its visible address input. Navigation must be confirmed on that same embedded webview.
- MCP's final check was not reached. Cleanup recorded no survivors. The executable, app.asar, and wavesrv hashes were independently rechecked after this failed overall run and still matched provenance.

### Complete signed-app follow-up: passed

Run `631f7896-d154-426d-8240-d8549c58c568` ran from **2026-09-21 03:17:47–03:18:07 UTC**, exited **0**, and recorded `status: passed` in `/private/tmp/hypheus-validation-418622bc-1hy08p0g/hypheus-terminal-approval-ij3tPy/result.json`. It used a new profile and the same unmodified signed `418622bce356d95045ab966d9a5746ba3f368223` artifact, not a rebuilt or re-signed app. The follow-up harness/evidence commit is separate from that tested binary revision.

| Check | Measured result |
| --- | --- |
| Packaged launch and onboarding | Visible initialized native renderer, packaged URL/window/tab identity, isolated userData/config/data/HOME and exact fresh shell prompt passed. |
| Default CroweLM | Unchanged `waveai@crowelm-auto`, exactly `HYPHEUS_SMOKE_OK`, no tool calls in the response check. |
| Exact visible proposal | `pwd`, local terminal `fea547fc-25dd-4163-9cd2-9277d7c3b99b`, tab `55584659-811c-4f6b-8ccb-b9dd0448b768`, call `toolu_01KRA5mwqmU1JUAdoJj2J5Zz`; visible plaintext, raw arguments, prepared metadata, and canonical target matched. |
| Approval typing only | Call-scoped Approve typing succeeded; terminal contained `HYPHEUS_24163778> pwd`, `lastcommand` remained null, no Enter/input or execution observed. Tool result reported `awaits: user_enter`. |
| Separate Enter and output | Revalidated the same call/target and exact typed line, sent one Enter (`\r`), observed exactly `pwd`, exact fresh-profile `.../hypheus-terminal-approval-ij3tPy/home` output and one new ready prompt. |
| Chat/composer layout | Renderer viewport widths 1280/1000/800; pane 458px, client/scroll widths both 454px, composer 432×63px and contained. Actual pane resizing to 320/450/720px was not tested in the signed app; the source-browser matrix covers those widths. |
| Browser navigation | Restored original 1396×799 renderer viewport. Filled and submitted the existing browser address input. That same webview block `b06a3567-8d47-4e09-8d93-adf6e269f668` returned `https://example.com/` and title `Example Domain`; inspected screenshot shows the page. Narrow browser content clipping remains a limitation, not a general browser-layout pass. |
| MCP startup | Fresh owned-app diagnostic `[agent-playwright] registered 25 playwright tools`; explicit headless/isolated command. No MCP tool invoked, no agent HTTP health check, no other MCP family tested. |
| Integrity and cleanup | Executable, app.asar, and wavesrv hashes still matched provenance at the end. Cleanup recorded zero owned-process survivors. Existing services were not stopped. |

Inspected screenshots: `04-pending-proposal.png`, `05-pwd-typed-not-executed.png`, `06-pwd-executed.png`, `07-layout-800.png`, and `08-browser-example.png`. Structured receipts include `verified-proposal.json`, `authorization-type.json`, `typed-not-executed.json`, `authorization-enter.json`, `pwd-result.json`, `layout.json`, `browser-example.json`, `mcp-startup.json`, and `cleanup.json`. The final browser and test-runner filename corrections received independent read-only review with no confirmed blocker; the Node regressions, full frontend suite, and TypeScript passed before this live run.

This is the agreed macOS validation pass, not approval to publish, broad platform-runtime certification, a persistent resolution of upstream rate limits, or a security sandbox claim. Evidence is local temporary data and is not guaranteed to survive cleanup; the checked-in report retains the measured result and provenance identifiers.

## Original artifact: revision and build provenance

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

**This source-preview subsection records the original `7fb93dd4` validation stage.** The layout fix was not in that original artifact; it is included in the new signed `418622bc` artifact described above. The 320/450/720px matrix remains source-preview evidence, not signed-app pane-resize coverage.

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

Static smoke-driver review found that a natural-language request and after-the-fact polling cannot enforce the user's exact-`pwd` authorization: widget access otherwise exposes additional tools, including command execution. The implementation now provides `CROWE_TERMINAL_APPROVAL_SMOKE=1`, read at process startup, enforcing a deny-only restriction at backend lookup and dispatch as well as both outgoing tool catalogs. Only terminal listing and approved command proposal remain; provider-native web search is disabled. The driver requires the exact fresh startup marker before sending any model request. Default application behavior is unchanged. Inert env-on tests and independent source review verified the restriction. The driver also reconstructs only xterm-marked soft-wrapped lines before exact cwd comparison. This is a model-tool restriction, not an OS sandbox. The later signed `418622bc` terminal smoke verified its startup marker before model requests; the env-on unit tests establish lookup/dispatch rejection behavior.

The backend's exact-text guarantee binds the prepared preview to the bytes sent. Direct raw terminal transport rejects malformed UTF-8/surrogates before JSON decoding, but provider adapters already decode their arguments and can replace malformed input first. This is not a guarantee that every malformed character in original provider JSON is rejected.

## Follow-up backend and harness checks

Focused Go tests run from the repository root with fake stores, events, input channels, and durable-job sinks. They cover scoped full/prefix resolution, ambiguity and wrong targets, exact bytes and control rejection, immutable preparation, destination/process/job changes, approval publication/cleanup, duplicate decisions, ordered existing-tool verification, and the smoke-only catalog/dispatch restriction. Race-detector runs passed; macOS linker `LC_DYSYMTAB` warnings were emitted. No test invoked a real model or terminal command. Approval IDs are reserved for the backend process lifetime, preventing a stale card from deciding a later request that reuses the same ID. The reservation retains only IDs, not command payloads, and grows with unique approvals until process exit.

```sh
go test ./pkg/agent/tools/terminal ./pkg/agent/transport/waveadapter ./pkg/aiusechat ./pkg/aiusechat/uctypes ./pkg/blockcontroller -run '^Test(TerminalProposal|TerminalApproval|ScreenshotToolExcludedFromWavePath|AppendAgentToolsPreservesExisting)' -count=1 -timeout=90s
CROWE_TERMINAL_APPROVAL_SMOKE=1 go test ./pkg/aiusechat ./pkg/aiusechat/uctypes -run '^TestTerminalApprovalSmoke' -count=1 -timeout=90s
```

The new `scripts/smoke-terminal-approval.cjs` passed syntax checking and independent static review. Its inert Node regressions run explicitly with `node --test scripts/smoke-terminal-approval.check.cjs`. The first filename ended in `.test.cjs`, causing Vitest to collect a Node-only suite and fail with `No test suite found` despite all 117 frontend assertions passing; the file was renamed rather than weakening Vitest configuration or failure detection. The subsequent explicit Node run passed all nine checks, the full frontend suite passed 117 tests in 18 files, and TypeScript and diff checks passed. It requires a newly verified artifact, hash/provenance JSON, explicit `--approve-exact-pwd`, a fresh profile and evidence directory, and the backend tool-restriction marker. Runtime success cannot be inferred from syntax checking. No prior approval marker is reused.

## Linux and Windows evidence

- Ubuntu 24.04 x64 and Ubuntu 24.04 ARM64 successfully built ZIP, DEB, RPM, Snap, AppImage, and pacman packages.
- Windows runner `windows-2025-vs2026` successfully built x64 NSIS EXE, MSI, and ZIP.
- Downloaded Windows MSI metadata identifies Hypheus and `Template: x64;1033`.
- Downloaded NSIS installer EXE and unpacked `Hypheus.exe` have an empty PE security directory, confirming no embedded Authenticode signature. Builder log lines saying `signing with signtool.exe` are not evidence of a signed result.
- No Linux or Windows install, launch, uninstall, or update test was performed. Their install paths and runtime support are not yet verified. Windows ARM64 emulation was not tested; no native ARM64 desktop artifact was built.
- macOS ZIP launch does not establish that Linux/Windows installers work.

## Distribution and remaining gates

The public GitHub `v0.15.7` release was rechecked and contains macOS assets only. Current Linux/Windows validation artifacts exist in Actions but are **not published releases**. No S3 upload was performed; `ENABLE_S3_STAGING` remains the workflow gate for optional staging/publishing. The configured generic update feed was not changed or validated.

Completed validation gates; publication remains held:

1. **Passed around 21:40 UTC:** the unchanged default CroweLM response recovered without substituting a model or bypassing authentication. Earlier rate-limit root cause remains undiagnosed.
2. **Passed on 2026-09-21 at 03:07 UTC in signed `418622bc`:** exact `pwd` proposal, visible canonical target, approved typing only, separate Enter, exact cwd output and returned prompt.
3. **Passed on 2026-09-21 at 03:18 UTC in a fresh signed `418622bc` run:** repeated terminal approval/output, viewport/composer containment, browser navigation and opt-in MCP startup. The earlier partial run remains recorded as failed; the distinct `ij3tPy` run supplies the overall pass.

The measured platform limitations above remain explicit rather than being promoted to passes. The follow-up smoke passed; stop for final packaging and release review. Do not bump the version, tag, cut, or publish the follow-up release under the current authorization. Any later authorized release review must verify its own artifacts and distribution state; this manual build does not prove tag-only behavior or update-feed publication.

No local `task package`, direct `go build`, or `go run` was run. The original artifact validation did not run local Go tests; the follow-up implementation added focused inert Go tests and ran them from the repository root. New tests use fake stores/events, buffered input channels, and a fake durable-job sink, not real terminal commands. CI exercised `task package` on all four runners for the original artifact. The independent Astra reasoning service returned HTTP 400, so it supplied no review result.
