// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Vm = require("node:vm");
const Fs = require("node:fs/promises");
const Os = require("node:os");
const Path = require("node:path");
const { createNativeAdapter } = require("./lib/rehearsal-native-adapter.cjs");
const { recordRehearsal } = require("./lib/rehearsal-recorder.cjs");

const WindowId = "11111111-1111-1111-1111-111111111111";
const TabId = "22222222-2222-2222-2222-222222222222";
const BlockId = "33333333-3333-3333-3333-333333333333";
const ExpectedUrl = "file:///unit-only/frontend/index.html";

// All DOM/native objects and image bytes are synthetic unit-only input. These
// fixtures cannot substantiate actual Electron visibility, captures or footage.
function syntheticPng(width, height, length = 64) {
    const data = Buffer.alloc(length);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
    data.writeUInt32BE(13, 8);
    data.write("IHDR", 12, "ascii");
    data.writeUInt32BE(width, 16);
    data.writeUInt32BE(height, 20);
    return data;
}

function fixture({ scale = 1, timeoutms = 1000, canceltimeoutms = 50 } = {}) {
    const state = { captures: 0, inspections: 0, evaluations: 0, visible: true, minimized: false, destroyed: false,
        viewvisible: true, contentvisible: true, loading: false, scale, pnglength: 64, empty: false,
        content: { x: 20, y: 30, width: 8, height: 6 }, url: ExpectedUrl, timeorigin: 1700000000000,
        rect: { x: 0, y: 0, width: 8, height: 6, left: 0, top: 0, right: 8, bottom: 6 },
        style: { display: "block", visibility: "visible", opacity: "1" }, visibility: "visible", terminals: 1 };
    const frame = { isConnected: true, parentElement: null, getBoundingClientRect: () => state.rect,
        getAttribute: () => state.frameid ?? BlockId, childElementCount: 1 };
    const atoms = { uiContext: "ui", staticTabId: "tab" };
    const wrap = { blockId: BlockId, tabId: TabId, loaded: true, terminal: { element: { closest: () => frame } } };
    const tab = { blockids: [BlockId] };
    const block = { meta: { view: "term", controller: "shell" } };
    const window = { term: wrap, globalAtoms: atoms, globalStore: { get: (atom) => atom === "ui" ? { windowid: state.rendererwindowid ?? WindowId } : (state.renderertabid ?? TabId) },
        WOS: { getObjectValue: (key) => key.startsWith("block:") ? block : tab } };
    const wc = { id: 5, mainFrame: { processId: 10, routingId: 11 }, isDestroyed: () => state.wcdestroyed ?? false,
        getURL: () => state.url, isLoading: () => state.loading, getZoomFactor: () => 1,
        async executeJavaScript(script, gesture) {
            assert.equal(gesture, false);
            state.inspections++;
            await state.oninspect?.();
            const result = Vm.runInNewContext(script, { window, document: { getElementById: () => frame,
                get visibilityState() { return state.visibility; }, readyState: "complete",
                querySelectorAll: () => Array.from({ length: state.terminals }, () => ({ closest: () => frame })) },
                getComputedStyle: () => state.style, innerWidth: 8, innerHeight: 6, devicePixelRatio: state.scale,
                location: { href: state.url }, performance: { timeOrigin: state.timeorigin } });
            return structuredClone(result);
        },
        async capturePage(rect, options) {
            assert.equal(rect, undefined);
            assert.deepEqual({ ...options }, { stayHidden: true, stayAwake: false });
            state.captures++;
            await state.oncapture?.();
            return { isEmpty: () => state.empty, getScaleFactors: () => state.imagescales ?? [state.scale],
                toPNG: (options) => {
                    assert.equal(options.scaleFactor, state.scale);
                    state.encodes = (state.encodes ?? 0) + 1;
                    return state.png ?? syntheticPng(8 * state.scale, 6 * state.scale, state.pnglength);
                } };
        } };
    const view = { isDestroyed: false, isActiveTab: true, isInitialized: true, isWaveReady: true, createdTs: 1700000000001,
        webContents: wc, waveWindowId: WindowId, waveTabId: TabId,
        getVisible: () => state.viewvisible, getBounds: () => state.bounds ?? { x: 0, y: 0, width: 8, height: 6 } };
    const win = { id: 7, waveWindowId: WindowId, activeTabView: view, isDestroyed: () => state.destroyed,
        isVisible: () => state.visible, isMinimized: () => state.minimized, getContentBounds: () => state.content,
        contentView: { children: [view], getVisible: () => state.contentvisible } };
    state.windows = [win];
    const electron = { BaseWindow: { getAllWindows: () => state.windows }, screen: { getDisplayMatching: () => ({ id: 2, scaleFactor: state.scale }) } };
    const context = Vm.createContext({ Buffer, Date });
    const app = { async evaluate(fn, request) {
        state.evaluations++;
        await state.onevaluate?.(request);
        // Execute the actual serialized function, with no access to its module's
        // lexical scope; executeJavaScript likewise executes its real source.
        const callback = Vm.runInContext(`(${fn.toString()})`, context);
        const result = await callback(electron, structuredClone(request));
        if (request.operation === "cancel") state.cancelack = structuredClone(result);
        return state.envelope ? state.envelope(structuredClone(result), request) : structuredClone(result);
    } };
    return { state, wc, view, win, wrap, tab, block, app, context,
        adapter: createNativeAdapter({ app, expectedurl: ExpectedUrl, blockid: BlockId, timeoutms, canceltimeoutms }) };
}

async function capture(f, maxbytes = 4096) {
    const target = await f.adapter.identity();
    return f.adapter.capture({ target, maxbytes });
}

test("configuration requires explicit existing app, packaged URL and canonical block", () => {
    for (const options of [undefined, {}, { app: {}, expectedurl: ExpectedUrl, blockid: BlockId },
        { app: { evaluate() {} }, expectedurl: "http://localhost:8011", blockid: BlockId },
        { app: { evaluate() {} }, expectedurl: ExpectedUrl, blockid: "bad" }]) assert.throws(() => createNativeAdapter(options), { code: "CONFIG" });
});

for (const scale of [1, 2]) test(`real serialized evaluator selects native tab and captures scale ${scale}`, async () => {
    const f = fixture({ scale });
    const target = await f.adapter.identity();
    assert.deepEqual(target, { windowid: WindowId, tabid: TabId, webcontentsid: 5, blockid: BlockId,
        visible: true, width: 8 * scale, height: 6 * scale, x: 20, y: 30, scale });
    const result = await f.adapter.capture({ target, maxbytes: 64 });
    assert.ok(Buffer.isBuffer(result.data));
    assert.equal(result.width, 8 * scale);
    assert.equal(result.height, 6 * scale);
    assert.equal(f.state.captures, 1);
    assert.equal(f.state.inspections, 3);
    assert.equal(f.state.evaluations, 2);
});

const InvalidSurfaces = {
    ambiguous: (f) => f.state.windows.push({ ...f.win, id: 8 }),
    hidden: (f) => { f.state.visible = false; },
    minimized: (f) => { f.state.minimized = true; },
    destroyed: (f) => { f.state.destroyed = true; },
    "hidden view": (f) => { f.state.viewvisible = false; },
    "hidden content": (f) => { f.state.contentvisible = false; },
    detached: (f) => { f.win.contentView.children = []; },
    inactive: (f) => { f.view.isActiveTab = false; },
    unready: (f) => { f.view.isWaveReady = false; },
    "destroyed webcontents": (f) => { f.state.wcdestroyed = true; },
    "wrong URL": (f) => { f.state.url = "file:///different"; },
    "wrong window": (f) => { f.view.waveWindowId = TabId; },
    "offscreen tab": (f) => { f.state.bounds = { x: -15000, y: 0, width: 8, height: 6 }; },
    "zero geometry": (f) => { f.state.content.width = 0; },
    "unbounded pixels": (f) => { f.state.content.width = 16385; f.state.bounds = { ...f.state.content, x: 0, y: 0 }; },
    "invalid scale": (f) => { f.state.scale = Infinity; },
    "wrong renderer window": (f) => { f.state.rendererwindowid = TabId; },
    "wrong renderer tab": (f) => { f.state.renderertabid = WindowId; },
    "wrong block": (f) => { f.wrap.blockId = TabId; },
    "wrong frame": (f) => { f.state.frameid = TabId; },
    "nonmember block": (f) => { f.tab.blockids = []; },
    "nonterminal block": (f) => { f.block.meta.view = "web"; },
    "hidden renderer": (f) => { f.state.visibility = "hidden"; },
    "hidden CSS": (f) => { f.state.style.opacity = "0"; },
    "multiple terminals": (f) => { f.state.terminals = 2; },
    "unbounded terminals": (f) => { f.state.terminals = 257; },
    "renderer loading": (f) => { f.state.loading = true; },
};
for (const [name, mutate] of Object.entries(InvalidSurfaces)) test(`actual evaluator rejects ${name} before capture`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(() => capture(f));
    assert.equal(f.state.captures, 0);
    await assert.rejects(() => f.adapter.identity(), { code: "STOPPED" });
});

test("pins native window, webcontents, renderer process, document and geometry between calls", async () => {
    for (const mutate of [(f) => { f.win.id++; }, (f) => { f.wc.id++; }, (f) => { f.wc.mainFrame.processId++; },
        (f) => { f.state.timeorigin++; }, (f) => { f.state.content.x++; }, (f) => { f.view.createdTs++; }]) {
        const f = fixture();
        const target = await f.adapter.identity();
        mutate(f);
        await assert.rejects(() => f.adapter.capture({ target, maxbytes: 4096 }));
        assert.equal(f.state.captures, 0);
    }
});

test("before and after capture revalidation rejects surface replacement and drift", async () => {
    for (const mutate of [(f) => { f.win.activeTabView = { ...f.view }; f.win.contentView.children = [f.win.activeTabView]; },
        (f) => { f.state.visible = false; }, (f) => { f.wc.mainFrame.routingId++; },
        (f) => { f.state.timeorigin++; }, (f) => { f.state.rect.width--; }, (f) => { f.state.content.x++; }]) {
        const f = fixture();
        f.state.oncapture = () => mutate(f);
        await assert.rejects(() => capture(f));
        assert.equal(f.state.captures, 1);
        assert.equal(f.state.encodes ?? 0, 0);
    }
    const f = fixture();
    f.state.oninspect = () => { f.state.content.x++; };
    await assert.rejects(() => capture(f));
    assert.equal(f.state.captures, 0);
});

test("empty, oversized, wrong scale and malformed native images never leave evaluator", async () => {
    for (const mutate of [(f) => { f.state.empty = true; }, (f) => { f.state.pnglength = 65; },
        (f) => { f.state.imagescales = [1, 2]; }, (f) => { f.state.png = syntheticPng(9, 6); },
        (f) => { f.state.png = Buffer.alloc(64); }]) {
        const f = fixture();
        mutate(f);
        await assert.rejects(() => capture(f, 64));
    }
});

test("host validates bounded IPC envelopes and canonical PNG bytes", async () => {
    for (const mutate of [(r) => { r.png += "AAAA"; }, (r) => { r.bytes = 65; },
        (r) => { r.png = "!" + r.png.slice(1); }, (r) => { r.target.width++; },
        (r) => { r.target.webcontentsid = "5"; }, (r) => { r.target.blockid = TabId; }]) {
        const f = fixture();
        f.state.envelope = (r, request) => { if (request.operation === "capture") mutate(r); return r; };
        await assert.rejects(() => capture(f, 64));
    }
});

test("pre-abort and mismatched caller target cannot dispatch capture", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => f.adapter.identity({ signal: controller.signal }), { code: "ABORT" });
    assert.equal(f.state.evaluations, 0);
    const g = fixture();
    const target = await g.adapter.identity();
    await assert.rejects(() => g.adapter.capture({ target: { ...target, blockid: TabId }, maxbytes: 64 }));
    assert.equal(g.state.captures, 0);
});

test("abort seals adapter, rejects overlap and discards noncancellable late result", async () => {
    const f = fixture();
    const target = await f.adapter.identity();
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    f.state.oncapture = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const controller = new AbortController();
    const pending = f.adapter.capture({ target, maxbytes: 64, signal: controller.signal });
    await started;
    await assert.rejects(() => f.adapter.capture({ target, maxbytes: 64 }), { code: "BUSY" });
    controller.abort();
    await assert.rejects(() => pending, { code: "ABORT" });
    await assert.rejects(() => f.adapter.identity(), { code: "STOPPED" });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.state.captures, 1);
});

function gate() {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
}

for (const stage of ["inspection", "dispatch"]) test(`acknowledged abort before native capture at ${stage} prevents late capture and encode`, async () => {
    const f = fixture();
    const target = await f.adapter.identity();
    const entered = gate();
    const held = gate();
    if (stage === "inspection") f.state.oninspect = () => { entered.release(); return held.promise; };
    else f.state.onevaluate = (request) => { if (request.operation === "capture") { entered.release(); return held.promise; } };
    const controller = new AbortController();
    const pending = f.adapter.capture({ target, maxbytes: 64, signal: controller.signal });
    await entered.promise;
    assert.equal(f.state.captures, 0);
    controller.abort();
    await assert.rejects(() => pending, { code: "ABORT", cancellation: "ACKNOWLEDGED", capturestarted: stage === "inspection" ? false : null });
    f.state.oninspect = null;
    held.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.state.captures, 0);
    assert.equal(f.state.encodes ?? 0, 0);
    await assert.rejects(() => f.adapter.identity(), { code: "STOPPED" });
});

test("acknowledged abort during noncancellable capture prevents post-capture inspection and encode", async () => {
    const f = fixture();
    const target = await f.adapter.identity();
    const entered = gate();
    const held = gate();
    f.state.oncapture = () => { entered.release(); return held.promise; };
    const controller = new AbortController();
    const pending = f.adapter.capture({ target, maxbytes: 64, signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(() => pending, { code: "ABORT", cancellation: "ACKNOWLEDGED", capturestarted: true });
    held.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.state.captures, 1);
    assert.equal(f.state.inspections, 2);
    assert.equal(f.state.encodes ?? 0, 0);
});

test("delayed or missing main cancellation acknowledgement is not confirmed ABORT", async () => {
    const f = fixture({ canceltimeoutms: 10 });
    const target = await f.adapter.identity();
    const entered = gate();
    const inspection = gate();
    const cancellation = gate();
    f.state.oninspect = () => { entered.release(); return inspection.promise; };
    f.state.onevaluate = (request) => request.operation === "cancel" ? cancellation.promise : null;
    const controller = new AbortController();
    const pending = f.adapter.capture({ target, maxbytes: 64, signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(() => pending, { code: "CANCEL_UNCONFIRMED", cancellation: "INDETERMINATE", causecode: "ABORT" });
    assert.equal(f.state.cancelack, undefined);
    cancellation.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.state.cancelack.cancelled, true);
    inspection.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.state.captures, 0);
    assert.equal(f.state.encodes ?? 0, 0);
});

test("main request registry does not accumulate successful operations", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) await capture(f);
    assert.equal(Vm.runInContext('globalThis[Symbol.for("hypheus.rehearsal.native.requests.v1")].size', f.context), 0);
});

test("recorder shorter slot timeout cancels blocked native inspection before capture", async (t) => {
    const f = fixture({ timeoutms: 1000 });
    const held = gate();
    let captureerror;
    f.state.oninspect = () => f.state.inspections === 3 ? held.promise : null;
    const root = await Fs.mkdtemp(Path.join(await Fs.realpath(Os.tmpdir()), "hypheus-native-cancel-unit-"));
    t.after(() => Fs.rm(root, { recursive: true, force: true }));
    const result = await recordRehearsal({ roots: [root], destination: Path.join(root, "run"), durationms: 50, intervalms: 100, timeoutms: 1000, maxframebytes: 4096 }, {
        ...f.adapter,
        capture: async (options) => { try { return await f.adapter.capture(options); } catch (error) { captureerror = error; throw error; } },
        capacity: async () => ({ bsize: 4096n, bavail: 100000000n }),
        clock: { now: () => 100, utc: () => new Date(1700000000100).toISOString(), sleep: async () => {}, setTimeout, clearTimeout },
    });
    assert.equal(result.reason.code, "TIMEOUT");
    assert.equal(result.frames, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captureerror?.cancellation, "ACKNOWLEDGED");
    held.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.state.captures, 0);
    assert.equal(f.state.encodes ?? 0, 0);
    assert.equal((await Fs.readdir(Path.join(root, "run"))).some((name) => name.endsWith(".png")), false);
});

test("hung evaluate has bounded timeout and cannot be reused", async () => {
    const adapter = createNativeAdapter({ app: { evaluate: () => new Promise(() => {}) }, expectedurl: ExpectedUrl, blockid: BlockId, timeoutms: 10, canceltimeoutms: 10 });
    await assert.rejects(() => adapter.identity(), { code: "CANCEL_UNCONFIRMED", cancellation: "INDETERMINATE", causecode: "TIMEOUT" });
    await assert.rejects(() => adapter.identity(), { code: "STOPPED" });
});

test("actual adapter plugs into existing recorder API; unit-only temporary artifacts", async (t) => {
    const f = fixture();
    const root = await Fs.mkdtemp(Path.join(await Fs.realpath(Os.tmpdir()), "hypheus-native-unit-"));
    t.after(() => Fs.rm(root, { recursive: true, force: true }));
    let mono = 100;
    const result = await recordRehearsal({ roots: [root], destination: Path.join(root, "run"), durationms: 50, intervalms: 100, timeoutms: 1000, maxframebytes: 4096 }, {
        ...f.adapter, capacity: async () => ({ bsize: 4096n, bavail: 100000000n }),
        clock: { now: () => mono, utc: () => new Date(1700000000000 + mono).toISOString(),
            sleep: async (ms) => { mono += ms; }, setTimeout, clearTimeout },
    });
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.frames, 1);
    assert.equal(result.mode, "timed-tab-surface-capture");
    assert.equal(f.state.captures, 1);
    assert.ok((await Fs.readFile(Path.join(root, "run", "frame-000000.png"))).equals(syntheticPng(8, 6)));
});
