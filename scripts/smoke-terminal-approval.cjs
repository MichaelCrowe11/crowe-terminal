#!/usr/bin/env node
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const ExecFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Commit = /^[0-9a-f]{40}$/;
const Digest = /^[0-9a-f]{64}$/;
const Command = "pwd";
const DefaultMode = "waveai@crowelm-auto";
const GuardSentinel = "[terminal-approval-smoke] restricted tools: terminal_list_blocks,terminal_propose_command";
const DeadlineMs = 300000;
const Help = `Packaged macOS terminal approval smoke (no build or dependency installation).

PLAYWRIGHT_MODULE=/absolute/existing/playwright-core/index.js node scripts/smoke-terminal-approval.cjs \\
  --app /absolute/Hypheus.app/Contents/MacOS/Hypheus \\
  --expected-artifact-commit FULL_COMMIT_SHA \\
  --artifact-provenance /absolute/download-provenance.json \\
  --approve-exact-pwd [--browser-example] [--playwright-mcp /absolute/existing/cli.js]

Optional --evidence-parent /absolute/existing/directory (default: OS temporary directory).
Every invocation creates a new private run directory; previous paths/markers are never reused.
Without --approve-exact-pwd this exits before launching, rather than inferring consent.
Only the proposed literal pwd and a separately checked Enter may reach the terminal.
CROWE_TERMINAL_APPROVAL_SMOKE=1 restricts backend model tool dispatch; the packaged
wavesrv startup sentinel must be observed before any model request. This is not an OS sandbox.

Provenance JSON (recorded by the artifact downloader, not fabricated by this driver):
{ "headsha": "40 hex", "runid": "CI run ID", "artifactid": "CI artifact ID",
  "artifactsha256": "64 hex", "files": { "executable": "64 hex", "asar": "64 hex",
  "wavesrv": "64 hex" }, "verification": { "codesign": true, "gatekeeper": true,
  "notarization": true } }
Commit/signature claims remain external attestations; file hashes are independently checked.
Profile/config isolation is not a security sandbox. The app's built-in read-only Foundry
health probe may contact an existing port-8011 service; renderer traffic to that port is
blocked once Electron automation attaches. Existing services are never stopped.
`;

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function active() {
    check(!stopping, "Run stopped; no further UI actions permitted");
    if (asynchronousFailure) throw asynchronousFailure;
}

function options() {
    const out = {};
    const switches = new Set(["approve-exact-pwd", "browser-example", "help"]);
    const values = new Set(["app", "expected-artifact-commit", "artifact-provenance", "evidence-parent", "playwright-mcp"]);
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        check(arg.startsWith("--"), `Unexpected argument ${arg}`);
        const name = arg.slice(2);
        check(!Object.hasOwn(out, name), `Duplicate option ${arg}`);
        if (switches.has(name)) out[name] = true;
        else {
            check(values.has(name), `Unknown option ${arg}`);
            check(process.argv[i + 1] && !process.argv[i + 1].startsWith("--"), `Missing value for ${arg}`);
            out[name] = process.argv[++i];
        }
    }
    return out;
}

function absoluteFile(value, label) {
    check(value && path.isAbsolute(value), `${label} must be an absolute existing file path`);
    const real = fs.realpathSync(value);
    check(fs.statSync(real).isFile(), `${label} is not a regular file`);
    return real;
}

async function sha256(file) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
}

function redact(text) {
    return String(text)
        .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
        .replace(/((?:authorization|[\w-]*(?:token|password|secret)|api[_-]?key|auth[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, "$1[redacted]");
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
let launching;
let page;
let root;
let stopping = false;
let deadline;
let monitor;
let monitorBusy = false;
let asynchronousFailure;
let interruptRun;
let phase = "setup";
const Owned = new Map();
const Evidence = { schema: 1, phases: [], limitations: ["macOS runtime only", "CI commit and signing status are downloader attestations, not embedded commit proof"] };

function write(name, data) {
    fs.writeFileSync(path.join(root, name), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", {
        flag: "wx", mode: 0o600,
    });
}

function record(name, data) {
    write(`${name}.json`, { runid: Evidence.runid, phase: name, timestamp: new Date().toISOString(), ...data });
    Evidence.phases.push(name);
}

async function bounded(label, fn, timeout = 15000) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(fn),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function until(label, fn, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        check(!stopping, "Run is stopping");
        if (asynchronousFailure) throw asynchronousFailure;
        const result = await bounded(label, fn);
        if (result) return result;
        await pause(150);
    }
    throw new Error(`${label} timed out; no approval or Enter fallback is permitted`);
}

async function processTable() {
    const { stdout } = await ExecFile("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim().split("\n").map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return match ? { pid: Number(match[1]), ppid: Number(match[2]), born: match[3] } : null;
    }).filter(Boolean);
}

async function trackOwned() {
    if (monitorBusy || !app) return;
    monitorBusy = true;
    try {
        const rows = await processTable();
        const initial = rows.find((row) => row.pid === app.process()?.pid);
        if (initial && !Owned.size) Owned.set(initial.pid, initial);
        let added;
        do {
            added = false;
            for (const row of rows) {
                if (Owned.has(row.pid)) continue;
                const parent = Owned.get(row.ppid);
                if (!parent || !rows.some((item) => item.pid === parent.pid && item.born === parent.born)) continue;
                Owned.set(row.pid, row);
                added = true;
            }
        } while (added);
    } finally {
        monitorBusy = false;
    }
}

async function cleanup() {
    stopping = true;
    clearInterval(monitor);
    if (launching && !app) await bounded("pending launch cleanup", () => launching, 65000).catch(() => {});
    let trackingFailure;
    try {
        if (monitorBusy) await bounded("process monitor drain", async () => { while (monitorBusy) await pause(25); }, 4000);
        await bounded("final process tracking", trackOwned, 4000);
    } catch (error) { trackingFailure = error; }
    if (app) await bounded("packaged app close", () => app.close(), 8000).catch(() => {});
    for (const signal of ["SIGTERM", "SIGKILL"]) {
        const rows = await processTable();
        for (const row of rows.reverse()) {
            if (Owned.get(row.pid)?.born !== row.born) continue;
            try { process.kill(row.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        await pause(300);
    }
    const survivors = (await processTable()).filter((row) => Owned.get(row.pid)?.born === row.born);
    check(survivors.length === 0, `Owned process cleanup incomplete: ${survivors.map((row) => row.pid).join(",")}`);
    if (root) record("cleanup", { trackedpids: [...Owned.keys()], survivors: [], trackingerror: trackingFailure?.message });
    if (trackingFailure) throw trackingFailure;
}

async function visibleNativeRenderers() {
    return app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().flatMap((win) => {
        if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return [];
        const view = win.activeTabView;
        if (!view || view.isDestroyed || !view.isActiveTab || !view.isInitialized || !view.isWaveReady ||
            !win.contentView.children.includes(view) || view.webContents.isDestroyed()) return [];
        const bounds = view.getBounds();
        const content = win.getContentBounds();
        if (bounds.x !== 0 || bounds.y !== 0 || bounds.width <= 0 || bounds.height <= 0 || content.width <= 0 || content.height <= 0) return [];
        return [{ nativewindowid: win.id, windowid: win.waveWindowId, tabid: view.waveTabId,
            viewwindowid: view.waveWindowId, webcontentsid: view.webContents.id, url: view.webContents.getURL(), bounds, content }];
    }));
}

async function selectVisibleRenderer(expectedUrl) {
    let lastNative = [];
    let lastPages = [];
    try {
        return await until("visible initialized packaged app renderer", async () => {
            lastNative = await visibleNativeRenderers();
            check(lastNative.length <= 1, "Multiple visible active app renderers; refusing ambiguous surface selection");
            if (lastNative.length === 0) return false;
            const native = lastNative[0];
            check(native.url === expectedUrl && UUID.test(native.windowid) && UUID.test(native.tabid) && native.viewwindowid === native.windowid,
                "Visible native surface has unexpected packaged URL or window/tab identity");
            const matches = [];
            lastPages = [];
            for (const candidate of app.windows()) {
                if (candidate.isClosed() || candidate.url() !== expectedUrl) continue;
                const renderer = await candidate.evaluate(() => {
                    const store = window.globalStore;
                    const atoms = window.globalAtoms;
                    const main = document.getElementById("main");
                    const bounds = main?.getBoundingClientRect();
                    return {
                        url: location.href, ready: document.readyState, visibility: document.visibilityState,
                        width: innerWidth, height: innerHeight, mainwidth: bounds?.width ?? 0, mainheight: bounds?.height ?? 0,
                        populated: Boolean(main?.childElementCount),
                        windowid: store && atoms?.uiContext ? store.get(atoms.uiContext).windowid : null,
                        tabid: store && atoms?.staticTabId ? store.get(atoms.staticTabId) : null,
                    };
                });
                lastPages.push(renderer);
                if (renderer.windowid !== native.windowid || renderer.tabid !== native.tabid || renderer.url !== expectedUrl) continue;
                if (renderer.ready === "loading" || renderer.visibility !== "visible" || renderer.width <= 0 || renderer.height <= 0 ||
                    renderer.mainwidth <= 0 || renderer.mainheight <= 0 || !renderer.populated) continue;
                matches.push({ candidate, renderer });
            }
            check(matches.length <= 1, "Multiple Playwright pages match the visible app identity");
            if (matches.length === 0) return false;
            const current = await visibleNativeRenderers();
            if (current.length !== 1 || current[0].webcontentsid !== native.webcontentsid || current[0].tabid !== native.tabid) return false;
            record("renderer-ready", { native: current[0], renderer: matches[0].renderer });
            return matches[0].candidate;
        });
    } catch (error) {
        record("renderer-selection-failure", { native: lastNative, renderers: lastPages });
        throw error;
    }
}

async function capture(name) {
    const file = path.join(root, `${name}.png`);
    fs.writeFileSync(file, await page.screenshot({ timeout: 10000 }), { flag: "wx", mode: 0o600 });
}

async function uiState() {
    return page.evaluate(() => {
        const model = window.WaveAIModel;
        const store = window.globalStore;
        if (!model || !store || !window.WOS || !window.globalAtoms) throw new Error("Required packaged runtime inspection hooks are unavailable");
        const messages = window.aichatmessages;
        if (!Array.isArray(messages)) throw new Error("Chat inspection hook is unavailable");
        return {
            chatid: model.getChatId(), status: window.aichatstatus,
            mode: store.get(model.currentAIMode), error: store.get(model.errorMessage),
            tabid: store.get(window.globalAtoms.staticTabId),
            assistants: messages.filter((m) => m.role === "assistant").map((m) => ({
                id: m.id, text: (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join(""),
            })),
            calls: messages.flatMap((m) => m.parts ?? []).filter((p) => p.type === "data-tooluse").map((p) => p.data),
        };
    });
}

function healthy(state) {
    check(state.mode === DefaultMode, `Default model changed: ${state.mode}`);
    check(!state.error && state.status !== "error", `Model/chat failure: ${redact(state.error || state.status)}`);
    check(new Set(state.calls.map((call) => call.toolcallid)).size === state.calls.length, "Duplicate UI tool-call IDs");
    for (const call of state.calls) {
        check(call.status !== "error" && !call.errormessage, `Tool ${call.toolcallid} failed`);
        check(!["user-denied", "auto-approved", "timeout"].includes(call.approval), `Unexpected approval state ${call.approval}`);
        check(["terminal.list_blocks", "terminal_list_blocks", "terminal.propose_command", "terminal_propose_command"].includes(call.toolname),
            `Unexpected tool ${call.toolname}; refusing further actions`);
    }
}

async function rawChat(chatid) {
    return page.evaluate(async (expected) => {
        const model = window.WaveAIModel;
        if (model.getChatId() !== expected) throw new Error("Chat changed before raw GET");
        const url = new URL("/wave/aichat", model.getUseChatEndpointUrl());
        if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
            throw new Error("Raw chat endpoint is not local HTTP");
        }
        url.searchParams.set("chatid", expected);
        const response = await fetch(url.href, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Raw chat GET returned ${response.status}`);
        const chat = await response.json();
        if (chat.chatid !== expected || !Array.isArray(chat.nativemessages)) throw new Error("Raw chat identity/schema mismatch");
        const messages = chat.nativemessages.map((m) => m.message);
        if (messages.some((m) => !m)) throw new Error("Unsupported native chat schema; refusing to guess");
        return {
            chatid: chat.chatid, model: chat.model, apitype: chat.apitype,
            calls: messages.flatMap((m) => m.tool_calls ?? []).map((call) => ({
                id: call.id, name: call.function?.name, arguments: call.function?.arguments, metadata: call.toolusedata,
            })),
            results: messages.filter((m) => m.role === "tool").map((m) => ({ id: m.tool_call_id, name: m.name, content: m.content })),
        };
    }, chatid);
}

async function terminalState() {
    return page.evaluate(() => {
        const wrap = window.term;
        const store = window.globalStore;
        const atoms = window.globalAtoms;
        if (!wrap?.terminal || !store || !atoms || !window.WOS) throw new Error("Terminal model inspection hooks unavailable");
        const term = wrap.terminal;
        const buffer = term.buffer.active;
        const block = window.WOS.getObjectValue(`block:${wrap.blockId}`);
        const tab = window.WOS.getObjectValue(`tab:${wrap.tabId}`);
        const frame = term.element?.closest("[data-blockid]");
        const rect = frame?.getBoundingClientRect();
        const rows = [];
        const physicalrows = [];
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            rows.push(line?.translateToString(true) ?? "");
            physicalrows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped === true });
        }
        return {
            blockid: wrap.blockId, tabid: wrap.tabId, statictabid: store.get(atoms.staticTabId),
            tabblocks: tab?.blockids, view: block?.meta?.view, controller: block?.meta?.controller,
            connection: block?.meta?.connection ?? "", cwd: block?.meta?.["cmd:cwd"],
            loaded: wrap.loaded, state: store.get(wrap.shellIntegrationStatusAtom), lastcommand: store.get(wrap.lastCommandAtom),
            multiinput: Boolean(wrap.multiInputCallback), pasteactive: wrap.pasteActive,
            buffer: buffer.type, cursorx: buffer.cursorX, cursory: buffer.baseY + buffer.cursorY,
            cols: term.cols, rows, physicalrows, markers: wrap.promptMarkers.map((m) => ({ id: m.id, line: m.line })),
            frameid: frame?.getAttribute("data-blockid"), visible: Boolean(rect?.width && rect?.height),
            visibleterminals: [...document.querySelectorAll("[data-blockid] .xterm-helper-textarea")].filter((el) => {
                const bounds = el.closest("[data-blockid]").getBoundingClientRect();
                return bounds.width > 0 && bounds.height > 0;
            }).length,
            focused: document.activeElement === term.textarea,
            observer: window.__hypheusTerminalSmoke ? {
                overflow: window.__hypheusTerminalSmoke.overflow,
                events: window.__hypheusTerminalSmoke.events,
            } : null,
        };
    });
}

function localConnection(value) { return value === "" || value === "local"; }

function targetReady(term, target, home) {
    check(UUID.test(term.blockid) && UUID.test(term.tabid), "Terminal identity is not a full canonical UUID");
    check(term.blockid === target.blockid && term.tabid === target.tabid && term.statictabid === target.tabid, "Terminal or tab changed");
    check(term.frameid === target.blockid && term.visible && term.visibleterminals === 1, "Expected exactly one visible canonical terminal");
    check(term.tabblocks?.includes(target.blockid), "Terminal no longer belongs to the target tab");
    check(term.view === "term" && term.controller === "shell", "Target is not a shell terminal");
    check(localConnection(term.connection) && term.connection === target.connection, "Terminal destination is not the pinned local connection");
    check(term.cwd === home, "Terminal working directory is not the fresh isolated home");
    check(term.loaded && term.state === "ready" && term.buffer === "normal" && !term.multiinput && !term.pasteactive,
        "Terminal is not an idle normal-buffer single-input shell");
    check(term.markers.length > 0 && term.markers.at(-1).line === term.cursory, "Cursor is not at the current shell prompt marker");
    check(term.observer && !term.observer.overflow, "Continuous terminal evidence is unavailable or overflowed");
    check(term.observer.events.every((event) => event.blockid === target.blockid && event.tabid === target.tabid), "Observed terminal identity changed");
}

function lineReady(term, text) {
    check(/^[\x20-\x7e]+$/.test(text), "Expected prompt/command must be printable ASCII");
    check(Number.isInteger(term.cols) && term.cols > text.length + 1, "Prompt/command would wrap; insufficient shell evidence");
    check(Number.isInteger(term.cursory) && term.cursory >= 0 && term.cursory < term.physicalrows.length &&
        term.physicalrows.length === term.rows.length, "Missing or inconsistent physical terminal rows");
    check(!term.physicalrows[term.cursory].wrapped, "Current prompt is a continuation of wrapped output");
    // xterm trimRight removes empty cells, not explicit space characters emitted by the shell.
    check((term.rows[term.cursory] === text || term.rows[term.cursory] === text.trimEnd()) &&
        term.physicalrows[term.cursory].text === text.padEnd(term.cols, " ") && term.cursorx === text.length,
        "Terminal line/cursor is not the exact expected prompt and input");
    check(term.rows.slice(term.cursory + 1).every((row) => row === "") &&
        term.physicalrows.slice(term.cursory + 1).every((row) => !row.wrapped && row.text === " ".repeat(term.cols)),
        "Unexpected output below the shell prompt");
}

function logicalOutput(term, firstrow, endrow) {
    check(firstrow >= 0 && endrow > firstrow && endrow <= term.physicalrows.length, "Invalid terminal output range");
    check(!term.physicalrows[firstrow].wrapped && !term.physicalrows[endrow]?.wrapped, "Output range splits a soft-wrapped logical line");
    const lines = [];
    for (let row = firstrow; row < endrow; row++) {
        const current = term.physicalrows[row];
        if (!current.wrapped) lines.push("");
        check(lines.length > 0, "Missing first segment of wrapped terminal output");
        const continues = row + 1 < endrow && term.physicalrows[row + 1].wrapped;
        lines[lines.length - 1] += continues ? current.text : current.text.replace(/ +$/, "");
    }
    return lines;
}

async function installObserver() {
    await page.evaluate(() => {
        if (window.__hypheusTerminalSmoke) throw new Error("Terminal observer already exists");
        const wrap = window.term;
        if (!wrap?.terminal || !window.globalStore) throw new Error("No inspectable terminal");
        const observer = { events: [], overflow: false, disposers: [] };
        const sample = (kind, data) => {
            if (observer.events.length >= 2000) { observer.overflow = true; return; }
            const buffer = wrap.terminal.buffer.active;
            observer.events.push({
                kind, data, timestamp: performance.now(), blockid: wrap.blockId, tabid: wrap.tabId,
                state: window.globalStore.get(wrap.shellIntegrationStatusAtom),
                lastcommand: window.globalStore.get(wrap.lastCommandAtom),
                cursorx: buffer.cursorX, cursory: buffer.baseY + buffer.cursorY,
                markers: wrap.promptMarkers.map((m) => ({ id: m.id, line: m.line })),
            });
        };
        observer.disposers.push(wrap.terminal.onWriteParsed(() => sample("parsed")));
        observer.disposers.push(wrap.terminal.onData((data) => sample("input", data)));
        observer.disposers.push(window.globalStore.sub(wrap.shellIntegrationStatusAtom, () => sample("shellstate")));
        observer.disposers.push(window.globalStore.sub(wrap.lastCommandAtom, () => sample("command")));
        window.__hypheusTerminalSmoke = observer;
        sample("baseline");
    });
}

function noExecution(term, baseline) {
    check(term.lastcommand === baseline.lastcommand && JSON.stringify(term.markers) === JSON.stringify(baseline.markers),
        "Command execution or a new prompt occurred before authorized Enter");
    check(term.cursory === baseline.cursory, "Terminal cursor moved to another row before Enter");
    check(JSON.stringify(term.rows.slice(0, baseline.cursory)) === JSON.stringify(baseline.rows.slice(0, baseline.cursory)),
        "Terminal output changed above the prompt before Enter");
    for (const event of term.observer.events) {
        check(event.kind !== "input", "Unexpected terminal keyboard input before Enter");
        check(event.state === "ready" && event.lastcommand === baseline.lastcommand &&
            JSON.stringify(event.markers) === JSON.stringify(baseline.markers), "Observed execution/state change before Enter");
    }
}

function proposal(state, raw, target, completed = false, expectedcall = null) {
    healthy(state);
    check(state.chatid === raw.chatid && UUID.test(state.chatid), "Chat identity mismatch");
    const pending = state.calls.filter((call) => call.status === "pending");
    check(pending.length === (completed ? 0 : 1), "Expected exactly one pending call before approval, zero after completion");
    const calls = state.calls.filter((call) => ["terminal.propose_command", "terminal_propose_command"].includes(call.toolname));
    check(calls.length === 1, "Expected exactly one terminal proposal in this fresh chat");
    const call = calls[0];
    check(!expectedcall || call.toolcallid === expectedcall, "Bound tool-call identity changed");
    check(typeof call.toolcallid === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(call.toolcallid), "Unsupported tool-call ID");
    check(call.approval === (completed ? "user-approved" : "needs-approval") && call.status === (completed ? "completed" : "pending"),
        "Proposal status/approval mismatch");
    const preview = call.terminalproposal;
    check(preview && preview.command === Command && preview.blockid === target.blockid && preview.tabid === target.tabid &&
        preview.connection === target.connection && localConnection(preview.connection), "UI terminalproposal differs from exact local target/command");
    check(UUID.test(preview.blockid) && UUID.test(preview.tabid), "Preview IDs must be full UUIDs");
    check(new Set(raw.calls.map((item) => item.id)).size === raw.calls.length, "Duplicate backend tool-call IDs");
    check(raw.calls.length === state.calls.length && raw.calls.every((item) => state.calls.some((ui) => ui.toolcallid === item.id)),
        "Backend/UI complete tool-call sets differ");
    for (const item of raw.calls) check(["terminal_list_blocks", "terminal_propose_command"].includes(item.name), `Unexpected raw tool ${item.name}`);
    const rawProposals = raw.calls.filter((item) => item.name === "terminal_propose_command");
    check(rawProposals.length === 1 && rawProposals[0].id === call.toolcallid, "Backend proposal call identity mismatch");
    const native = rawProposals[0];
    const args = JSON.parse(native.arguments);
    check(args.command === Command && args.blockid === target.blockid,
        "Raw command/target does not match the explicitly requested canonical proposal");
    check(Object.keys(args).sort().join(",") === "blockid,command", "Unexpected raw proposal arguments");
    check(JSON.stringify(native.metadata?.terminalproposal) === JSON.stringify(preview), "Backend/UI prepared proposal metadata mismatch");
    check(native.metadata?.toolcallid === call.toolcallid && native.metadata?.approval === call.approval && native.metadata?.status === call.status,
        "Backend/UI tool approval/status mismatch");
    check(raw.calls.filter((item) => item.metadata?.status === "pending").length === (completed ? 0 : 1), "Unexpected extra backend pending call");
    if (completed) {
        const results = raw.results.filter((result) => result.id === call.toolcallid);
        check(results.length === 1, "Expected one persisted tool result for this call");
        const result = JSON.parse(results[0].content);
        check(result.proposed === true && result.blockid === target.blockid && result.command === Command && result.awaits === "user_enter",
            "Tool result does not attest exact typing without execution");
    } else check(!raw.results.some((result) => result.id === call.toolcallid), "Proposal already has a result before approval");
    return call;
}

async function main(opts) {
    check(process.platform === "darwin", "This driver currently supports only packaged macOS artifacts");
    check(opts["approve-exact-pwd"] === true, "Explicit --approve-exact-pwd is required; no app was launched");
    check(Commit.test(opts["expected-artifact-commit"] ?? ""), "--expected-artifact-commit must be a full lowercase 40-hex commit");
    const executable = absoluteFile(opts.app, "--app");
    check(/\.app\/Contents\/MacOS\/[^/]+$/.test(executable), "--app must be the actual packaged macOS executable");
    const playwright = absoluteFile(process.env.PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE");
    const proofFile = absoluteFile(opts["artifact-provenance"], "--artifact-provenance");
    const proof = JSON.parse(fs.readFileSync(proofFile, "utf8"));
    check(proof.headsha === opts["expected-artifact-commit"] && proof.runid && proof.artifactid && Digest.test(proof.artifactsha256), "Artifact provenance identity is incomplete or mismatched");
    check(["codesign", "gatekeeper", "notarization"].every((key) => proof.verification?.[key] === true), "Downloader must attest signature, Gatekeeper and notarization verification");
    const resources = path.resolve(path.dirname(executable), "../Resources");
    const files = { executable, asar: path.join(resources, "app.asar"), wavesrv: path.join(resources, "app.asar.unpacked/dist/bin", `wavesrv.${process.arch}`) };
    const hashes = {};
    for (const [key, file] of Object.entries(files)) {
        check(Digest.test(proof.files?.[key]), `Missing provenance SHA256 for ${key}`);
        hashes[key] = await sha256(absoluteFile(file, key));
        check(hashes[key] === proof.files[key], `${key} digest mismatch; refusing to launch`);
    }
    const mcp = opts["playwright-mcp"] ? absoluteFile(opts["playwright-mcp"], "--playwright-mcp") : null;
    check(!mcp || (!mcp.includes(",") && !process.execPath.includes(",")), "MCP paths cannot contain commas");
    const parent = fs.realpathSync(opts["evidence-parent"] ?? os.tmpdir());
    check(path.isAbsolute(parent) && fs.statSync(parent).isDirectory(), "Evidence parent must be an existing absolute directory");
    root = fs.mkdtempSync(path.join(parent, "hypheus-terminal-approval-"));
    fs.chmodSync(root, 0o700);
    Evidence.runid = crypto.randomUUID();
    Evidence.started = new Date().toISOString();
    Evidence.expectedartifactcommit = proof.headsha;
    Evidence.evidencepath = root;
    console.log(`Fresh evidence: ${root}`);
    record("provenance", {
        expectedartifactcommit: proof.headsha, attestationsource: proofFile,
        attestation: { headsha: proof.headsha, runid: proof.runid, artifactid: proof.artifactid,
            artifactsha256: proof.artifactsha256, verification: { codesign: true, gatekeeper: true, notarization: true } },
        files, hashes,
    });
    const dirs = {};
    for (const name of ["home", "config", "data", "electron", "tmp", "cache", "xdgconfig", "xdgdata", "runtime"]) {
        dirs[name] = path.join(root, name);
        fs.mkdirSync(dirs[name], { mode: 0o700 });
    }
    const prompt = `HYPHEUS_${crypto.randomBytes(4).toString("hex")}> `;
    fs.writeFileSync(path.join(dirs.home, ".zshrc"), `PROMPT='${prompt}'\nRPROMPT=''\nPS2='SMOKE_CONTINUATION> '\nHISTSIZE=0\nSAVEHIST=0\n`, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(dirs.config, "settings.json"), JSON.stringify({
        "autoupdate:enabled": false, "autoupdate:installonquit": false, "telemetry:enabled": false,
        "term:localshellpath": "/bin/zsh", "term:localshellopts": ["-d"], "term:durable": false,
        "web:defaulturl": "about:blank",
    }, null, 2), { flag: "wx", mode: 0o600 });
    Evidence.limitations.push("Profile isolation is not a security sandbox; packaged app may issue its built-in read-only Foundry health probe to existing port 8011");
    const env = {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: dirs.home, TMPDIR: dirs.tmp,
        USER: os.userInfo().username, LOGNAME: os.userInfo().username, LANG: "en_US.UTF-8", SHELL: "/bin/zsh",
        XDG_CONFIG_HOME: dirs.xdgconfig, XDG_DATA_HOME: dirs.xdgdata, XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.runtime,
        WAVETERM_HOME: path.join(root, "unused-legacy"), WAVETERM_CONFIG_HOME: dirs.config, WAVETERM_DATA_HOME: dirs.data,
        WAVETERM_NOCONFIRMQUIT: "1", CROWE_AGENT_DISABLED: "1", CROWE_TERMINAL_APPROVAL_SMOKE: "1",
    };
    if (mcp) {
        env.CROWE_AGENT_PLAYWRIGHT = "1";
        env.CROWE_AGENT_PLAYWRIGHT_CMD = `${process.execPath},${mcp},--headless,--isolated`;
    }
    record("isolation", { dirs, prompt, envkeys: Object.keys(env), agenthttp: "disabled", bridge: "existing service preserved; built-in read-only health probe possible", mcp: mcp || "disabled" });
    const { _electron } = require(playwright);
    check(_electron?.launch, "PLAYWRIGHT_MODULE does not export _electron.launch");
    phase = "launch";
    active();
    launching = _electron.launch({ executablePath: executable, args: [`--user-data-dir=${dirs.electron}`], cwd: dirs.home, env, timeout: 60000 })
        .then((launched) => { app = launched; return launched; });
    await launching;
    if (stopping) throw asynchronousFailure ?? new Error("Run stopped during launch");
    await app.context().route(/http:\/\/(127\.0\.0\.1|localhost):8011\//, (route) => route.abort());
    await trackOwned();
    monitor = setInterval(() => { trackOwned().catch((error) => { asynchronousFailure = error; interruptRun?.(error); }); }, 250);
    let mcpRegistered = false;
    let guardActive = false;
    let guardSource;
    // Only retain allowlisted diagnostics; arbitrary runtime logs can include app-generated credentials.
    const diagnostics = [];
    const consumeLogLine = (line, source) => {
        const message = line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /, "")
            .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? /, "");
        if (message === GuardSentinel) { guardActive = true; guardSource = source; }
        if (/^\[agent-playwright\] registered [1-9]\d* playwright tools$/.test(message)) mcpRegistered = true;
        if ((message === GuardSentinel || /^\[agent-playwright\] registered [1-9]\d* playwright tools$/.test(message)) &&
            !diagnostics.includes(message)) diagnostics.push(message);
    };
    const streamListener = (source) => {
        let pending = "";
        return (chunk) => {
            pending = (pending + chunk.toString()).slice(-16384);
            const lines = pending.split("\n");
            pending = lines.pop();
            for (const line of lines) consumeLogLine(line, source);
        };
    };
    app.process().stdout?.on("data", streamListener("owned-electron-stdout"));
    app.process().stderr?.on("data", streamListener("owned-electron-stderr"));
    const startupLog = path.join(dirs.data, "waveapp.log");
    let startupOffset = 0;
    let startupPending = "";
    const scanStartupLog = () => {
        if (!fs.existsSync(startupLog)) return;
        const stat = fs.lstatSync(startupLog);
        check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 10 * 1024 * 1024 && stat.size >= startupOffset,
            "Fresh startup log changed identity, rotated, or exceeded bounded evidence size");
        if (stat.size === startupOffset) return;
        const fd = fs.openSync(startupLog, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const bytes = Buffer.alloc(stat.size - startupOffset);
            const count = fs.readSync(fd, bytes, 0, bytes.length, startupOffset);
            startupOffset += count;
            const lines = (startupPending + bytes.toString("utf8", 0, count)).split("\n");
            startupPending = lines.pop();
            check(startupPending.length < 16384, "Oversized startup diagnostic line");
            for (const line of lines) consumeLogLine(line, startupLog);
        } finally { fs.closeSync(fd); }
    };
    const info = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged, version: app.getVersion(), apppath: app.getAppPath(), executable: process.execPath,
        userdata: app.getPath("userData"), home: app.getPath("home"), envhome: process.env.HOME, resources: process.resourcesPath, arch: process.arch,
    }));
    record("runtime-identity", info);
    check(info.packaged && fs.realpathSync(info.executable) === executable && info.resources === resources && info.apppath === files.asar,
        "Launched app is not the expected packaged artifact");
    check(info.userdata === dirs.electron && info.envhome === dirs.home && info.arch === process.arch, "Runtime profile/HOME/architecture is not isolated as expected");
    if (info.home !== dirs.home) Evidence.limitations.push("Electron native home remains the macOS account home; HOME, backend config/data, shell cwd, and prompt are checked separately");
    phase = "renderer-readiness";
    page = await selectVisibleRenderer(pathToFileURL(path.join(files.asar, "dist/frontend/index.html")).href);
    page.setDefaultTimeout(10000);
    const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await capture("01-startup");
    for (let i = 0; i < 8; i++) {
        const next = page.getByText(/^(Continue|Skip Feature Tour >|Get Started)$/).filter({ visible: true });
        if (!(await next.count())) break;
        check(await next.count() === 1, "Ambiguous onboarding control");
        await next.click();
        await pause(250);
    }
    const panel = page.locator('[data-waveai-panel="true"]');
    const input = panel.locator('textarea[placeholder="Ask Hypheus anything..."], textarea[placeholder="Continue..."]');
    if (!(await input.isVisible())) await page.keyboard.press("Meta+Shift+A");
    await input.waitFor({ state: "visible", timeout: 15000 });
    const profile = await page.evaluate(() => ({ data: window.api.getDataDir(), config: window.api.getConfigDir() }));
    check(profile.data === dirs.data && profile.config === dirs.config, "App backend data/config paths escaped isolation");
    const initial = await until("fresh chat initialization", async () => {
        const state = await uiState();
        healthy(state);
        return state.status === "ready" && state.chatid && state;
    });
    check(initial.calls.length === 0 && initial.assistants.length === 0, "Chat is not fresh; refusing to clear or reuse it");
    phase = "shell-readiness";
    let shellObserved;
    let lineError;
    let baseline;
    let target;
    let samples = 0;
    try {
        await until("isolated shell integration readiness", async () => {
            shellObserved = await terminalState();
            if (samples++ === 0) record("terminal-first-observation", { expectedprompt: prompt, expectedcwd: dirs.home, terminal: shellObserved });
            check(shellObserved.lastcommand == null, "Fresh terminal has already executed a command");
            return shellObserved.loaded && shellObserved.state === "ready" && shellObserved.cwd === dirs.home;
        });
        await installObserver();
        shellObserved = await terminalState();
        target = { blockid: shellObserved.blockid, tabid: shellObserved.tabid, connection: shellObserved.connection };
        record("terminal-prompt-observation", { target, expectedprompt: prompt, terminal: shellObserved });
        // OSC A is emitted from precmd, before zsh renders the prompt and places the input cursor.
        baseline = await until("exact empty isolated shell prompt", async () => {
            shellObserved = await terminalState();
            samples++;
            targetReady(shellObserved, target, dirs.home);
            check(shellObserved.lastcommand == null && shellObserved.observer.events.every((event) =>
                event.kind !== "input" && event.lastcommand == null && event.state === "ready"),
                "Unexpected input or execution while waiting for the initial prompt");
            try { lineReady(shellObserved, prompt); } catch (error) {
                lineError = error.message;
                return false;
            }
            return shellObserved;
        }, 15000);
        record("terminal-baseline", { target, expectedprompt: prompt, samples, baseline });
        targetReady(baseline, target, dirs.home);
        lineReady(baseline, prompt);
        check(baseline.lastcommand == null, "Fresh terminal has already executed a command");
    } catch (error) {
        record("terminal-readiness-failure", { target, expectedprompt: prompt, expectedcwd: dirs.home,
            samples, lineerror: lineError, terminal: shellObserved });
        throw error;
    }
    await capture("02-onboarded");

    phase = "tool-dispatch-guard";
    await until("required wavesrv restricted-tool startup sentinel", () => {
        scanStartupLog();
        return guardActive;
    }, 10000);
    record("tool-dispatch-guard", { active: true, environment: "CROWE_TERMINAL_APPROVAL_SMOKE=1", sentinel: GuardSentinel,
        source: guardSource, allowedtools: ["terminal_list_blocks", "terminal_propose_command"],
        scope: "Backend model catalog and dispatch restriction only; not an OS sandbox" });
    phase = "default-model";
    check(guardActive, "Backend smoke tool restriction was not verified");
    const tools = panel.getByRole("button", { name: "tools", exact: true });
    if (await tools.getAttribute("aria-pressed") === "true") await tools.click();
    await input.fill("Release smoke test. Do not use any tools. Reply with exactly HYPHEUS_SMOKE_OK.");
    active();
    check(guardActive, "Backend smoke tool restriction was not verified");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    const defaultState = await until("default CroweLM exact response", async () => {
        const state = await uiState();
        healthy(state);
        check(state.chatid === initial.chatid, "Fresh chat identity changed during default-model check");
        check(state.calls.length === 0, "Default response unexpectedly used tools");
        if (state.status !== "ready" || !state.assistants.length) return false;
        check(state.assistants.length === 1 && state.assistants[0].text === "HYPHEUS_SMOKE_OK", "Default response was not exactly HYPHEUS_SMOKE_OK");
        return state;
    });
    record("default-model", { state: defaultState });
    await capture("03-default-model");

    phase = "proposal";
    check(guardActive, "Backend smoke tool restriction was not verified");
    if (await tools.getAttribute("aria-pressed") !== "true") await tools.click();
    await input.fill(`Release validation: use terminal.propose_command exactly once to propose exactly pwd in the existing local terminal ${target.blockid} in tab ${target.tabid}. Use terminal.list_blocks only if needed. Do not use terminal.exec_safe or any other tool or command. Do not execute or append a newline. Stop after this one proposal; approval only types the command and Enter is a separate user action.`);
    active();
    check(guardActive, "Backend smoke tool restriction was not verified");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    const pending = await until("single pending pwd proposal", async () => {
        const state = await uiState();
        healthy(state);
        const term = await terminalState();
        targetReady(term, target, dirs.home);
        lineReady(term, prompt);
        noExecution(term, baseline);
        const needs = state.calls.filter((call) => call.approval === "needs-approval");
        check(needs.length <= 1, "Extra pending approval calls");
        return needs.length === 1 && state;
    });
    check(pending.chatid === initial.chatid, "Fresh chat identity changed before proposal");
    const native = await rawChat(pending.chatid);
    const call = proposal(pending, native, target);
    const card = panel.locator(`[data-toolcallid="${call.toolcallid}"]`);
    check(await card.count() === 1, "Missing or duplicate call-scoped approval card");
    await card.scrollIntoViewIfNeeded();
    const commandPreview = card.getByTestId("terminal-command");
    check(await commandPreview.count() === 1 && await commandPreview.isVisible() && await commandPreview.textContent() === Command, "Exact visible command preview missing");
    check(await card.getByTestId("terminal-target").textContent() === target.blockid, "Canonical visible target differs from proposal");
    check((await card.innerText()).includes(target.blockid) && (await card.innerText()).includes(target.tabid), "Full terminal/tab identity is not visible in card");
    const before = await terminalState();
    targetReady(before, target, dirs.home);
    lineReady(before, prompt);
    noExecution(before, baseline);
    record("verified-proposal", { chatid: pending.chatid, call, native, terminal: before });
    await capture("04-pending-proposal");
    const binding = { runid: Evidence.runid, chatid: pending.chatid, toolcallid: call.toolcallid, ...target, command: Command, artifactcommit: proof.headsha };
    record("authorization-type", { ...binding, authorization: "Explicit user authorization for exact pwd in the new artifact, activated by --approve-exact-pwd", action: "Approve typing only", terminal: before });
    proposal(await uiState(), await rawChat(binding.chatid), target, false, binding.toolcallid);
    const lastBefore = await terminalState();
    targetReady(lastBefore, target, dirs.home);
    lineReady(lastBefore, prompt);
    noExecution(lastBefore, baseline);
    phase = "approve-typing";
    active();
    await card.getByRole("button", { name: "Approve typing", exact: true }).click();
    const completed = await until("approved typing completion", async () => {
        const state = await uiState();
        healthy(state);
        check(state.chatid === binding.chatid, "Chat changed during approval");
        check(state.calls.filter((item) => item.status === "pending").every((item) => item.toolcallid === binding.toolcallid), "Unexpected extra pending call after click");
        const current = state.calls.find((item) => item.toolcallid === binding.toolcallid);
        check(current, "Approved call disappeared");
        const term = await terminalState();
        noExecution(term, baseline);
        if (await card.locator('[role="alert"]').count()) throw new Error("Approval UI reported an RPC error; refusing automatic retry");
        return current.status === "completed" && state.status === "ready" && state;
    });
    const completedNative = await rawChat(binding.chatid);
    proposal(completed, completedNative, target, true, binding.toolcallid);
    const typed = await terminalState();
    targetReady(typed, target, dirs.home);
    lineReady(typed, prompt + Command);
    noExecution(typed, baseline);
    record("typed-not-executed", { ...binding, state: completed, native: completedNative, terminal: typed });
    await capture("05-pwd-typed-not-executed");

    phase = "enter";
    const textarea = page.locator(`[data-blockid="${target.blockid}"] .xterm-helper-textarea`);
    check(await textarea.count() === 1, "Exact target textarea is missing or ambiguous");
    await textarea.focus();
    const enterReady = await terminalState();
    targetReady(enterReady, target, dirs.home);
    lineReady(enterReady, prompt + Command);
    noExecution(enterReady, baseline);
    check(enterReady.focused, "Canonical target terminal is not focused");
    proposal(await uiState(), await rawChat(binding.chatid), target, true, binding.toolcallid);
    record("authorization-enter", { ...binding, authorization: "User separately authorized Enter only after exact pwd typing and idle local target verification", action: "One Enter key", terminal: enterReady });
    const finalEnterReady = await terminalState();
    targetReady(finalEnterReady, target, dirs.home);
    lineReady(finalEnterReady, prompt + Command);
    noExecution(finalEnterReady, baseline);
    check(finalEnterReady.focused, "Target focus changed immediately before Enter");
    active();
    await textarea.press("Enter");
    const result = await until("pwd output and new ready prompt", async () => {
        const term = await terminalState();
        check(term.blockid === target.blockid && term.tabid === target.tabid, "Target changed after Enter");
        if (term.state !== "ready" || term.markers.length <= baseline.markers.length) return false;
        targetReady(term, target, dirs.home);
        lineReady(term, prompt);
        check(term.lastcommand === Command, "Executed command was not exactly pwd");
        check(term.markers.length === baseline.markers.length + 1 && term.markers.at(-1).id !== baseline.markers.at(-1).id,
            "Expected exactly one new shell prompt");
        const output = logicalOutput(term, baseline.cursory, term.cursory);
        check(JSON.stringify(output) === JSON.stringify([prompt + Command, dirs.home]), "Terminal output is not exactly the typed pwd line and isolated working directory");
        const inputs = term.observer.events.filter((event) => event.kind === "input").map((event) => event.data);
        check(JSON.stringify(inputs) === JSON.stringify(["\r"]), "Terminal received input other than the one authorized Enter");
        check(term.observer.events.some((event) => event.state === "running-command") && term.observer.events.some((event) => event.lastcommand === Command),
            "Missing continuous shell execution evidence");
        check(term.observer.events.every((event) => event.lastcommand == null || event.lastcommand === Command), "Unexpected command in shell evidence");
        return term;
    }, 15000);
    proposal(await uiState(), await rawChat(binding.chatid), target, true, binding.toolcallid);
    record("pwd-result", { ...binding, expectedcwd: dirs.home, terminal: result });
    await capture("06-pwd-executed");

    phase = "layout";
    const layout = [];
    for (const width of [1280, 1000, 800]) {
        await page.setViewportSize({ width, height: 900 });
        await input.fill("Composer resize check\nSecond line\nThird line");
        const dimensions = await panel.evaluate((element) => {
            const textarea = element.querySelector("textarea");
            const r = textarea.getBoundingClientRect();
            const p = element.getBoundingClientRect();
            return { panelwidth: p.width, panelscrollwidth: element.scrollWidth, panelclientwidth: element.clientWidth,
                composerwidth: r.width, composerheight: r.height, withinpanel: r.left >= p.left - 1 && r.right <= p.right + 1 };
        });
        check(dimensions.withinpanel && dimensions.composerwidth > 0 && dimensions.panelscrollwidth <= dimensions.panelclientwidth + 1, "Chat/composer horizontal overflow");
        layout.push({ windowwidth: width, ...dimensions });
        await capture(`07-layout-${width}`);
    }
    await input.fill("");
    record("layout", { observations: layout, scope: "Renderer viewport resizing and multiline composer only; the AI pane was not independently resized or tested at 320/450/720px" });
    phase = "restore-viewport";
    await page.setViewportSize(originalViewport);
    await until("original renderer viewport restored", () => page.evaluate((expected) =>
        innerWidth === expected.width && innerHeight === expected.height && document.visibilityState === "visible", originalViewport), 10000);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    record("viewport-restored", { original: originalViewport, actual: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
    if (opts["browser-example"]) {
        phase = "browser-example";
        const webblock = await page.evaluate((tabid) => {
            const tab = window.WOS.getObjectValue(`tab:${tabid}`);
            const blocks = (tab?.blockids ?? []).map((id) => window.WOS.getObjectValue(`block:${id}`)).filter((block) => block?.meta?.view === "web");
            return blocks.map((block) => ({ blockid: block.oid, hidenav: block.meta["web:hidenav"] === true }));
        }, target.tabid);
        check(webblock.length === 1 && UUID.test(webblock[0].blockid) && !webblock[0].hidenav, "Expected one existing browser block with navigation enabled");
        const browserBlockId = webblock[0].blockid;
        const browserFrame = page.locator(`.block-frame-default[data-blockid="${browserBlockId}"]:not(.block-preview)`);
        const url = browserFrame.locator("input.block-frame-input.url-input");
        await until("existing browser address input visible after viewport restoration", async () => {
            check(await browserFrame.count() <= 1 && await url.count() <= 1, "Ambiguous existing browser address input");
            return await url.count() === 1 && await url.isVisible() && await url.isEnabled();
        }, 15000);
        await url.scrollIntoViewIfNeeded();
        record("browser-address-ready", { blockid: browserBlockId, viewport: originalViewport, selector: "input.block-frame-input.url-input", bounds: await url.boundingBox() });
        active();
        await url.fill("https://example.com");
        check(await url.inputValue() === "https://example.com", "Browser address input did not retain exact example.com URL");
        await url.press("Enter");
        const browsers = await until("example.com navigation", () => page.evaluate((blockid) => {
            const matches = [...document.querySelectorAll("webview.webview")].filter((view) => view.getAttribute("data-blockid") === blockid);
            if (matches.length !== 1) throw new Error("Existing browser webview is missing or ambiguous");
            const view = matches[0];
            const url = view.getURL();
            const title = view.getTitle();
            return url === "https://example.com/" && title === "Example Domain" ? [{ blockid, url, title }] : null;
        }, browserBlockId), 30000);
        record("browser-example", { browsers });
        await capture("08-browser-example");
    } else Evidence.limitations.push("Browser example.com navigation not opted in");
    if (mcp) {
        phase = "mcp-startup";
        scanStartupLog();
        check(mcpRegistered, "Opt-in MCP startup not observed; no tool invocation will be used to force it");
        record("mcp-startup", { script: mcp, registered: true, toolsinvoked: false, diagnostics });
    } else Evidence.limitations.push("Playwright MCP startup not opted in");
    for (const [key, file] of Object.entries(files)) check(await sha256(file) === hashes[key], `Packaged ${key} changed during smoke`);
    phase = "complete";
}

async function run() {
    let opts;
    try {
        opts = options();
        if (opts.help) { console.log(Help); return; }
        const interrupted = new Promise((_, reject) => { interruptRun = reject; });
        const stop = (reason) => {
            asynchronousFailure = new Error(reason);
            stopping = true;
            interruptRun(asynchronousFailure);
        };
        process.once("SIGINT", () => stop("Interrupted by SIGINT"));
        process.once("SIGTERM", () => stop("Interrupted by SIGTERM"));
        deadline = setTimeout(() => stop("Overall smoke deadline exceeded"), DeadlineMs);
        await Promise.race([main(opts), interrupted]);
        if (asynchronousFailure) throw asynchronousFailure;
        Evidence.status = "passed";
    } catch (error) {
        Evidence.status = "failed";
        Evidence.failedphase = phase;
        Evidence.error = redact(error.message);
        console.error(`Smoke failed (${phase}): ${Evidence.error}`);
        process.exitCode = 1;
        if (root && page) await bounded("failure screenshot", () => capture("99-failure"), 11000).catch(() => {});
    } finally {
        clearTimeout(deadline);
        if (root || app || launching) {
            try { await cleanup(); } catch (error) {
                Evidence.status = "failed";
                Evidence.cleanuperror = redact(error.message);
                process.exitCode = 1;
                console.error(`Cleanup failed: ${Evidence.cleanuperror}`);
            }
        }
        if (root) {
            Evidence.finished = new Date().toISOString();
            write("result.json", Evidence);
            console.log(`Smoke ${Evidence.status}: ${root}/result.json`);
        }
    }
}

if (require.main === module) {
    run().catch((error) => { console.error(redact(error.message)); process.exitCode = 1; });
}

module.exports = { lineReady, logicalOutput };
