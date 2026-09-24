// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const { randomUUID } = require("node:crypto");
const { snapshot } = require("./rehearsal-recorder.cjs");
const { failure, integer } = require("./rehearsal-storage.cjs");

const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IdentityKeys = ["windowid", "tabid", "webcontentsid", "blockid", "visible", "width", "height", "x", "y", "scale"];
const NativeKeys = ["nativewindowid", "displayid", "dipwidth", "dipheight", "processid", "routingid", "timeorigin", "zoom", "createdts"];

// This function must survive ElectronApplication.evaluate serialization without
// module closures. Renderer evaluation is passive inspection, never UI injection.
async function inspectNativeSurface({ BaseWindow, screen }, request) {
    function fail(message) { throw new Error(message); }
    const key = Symbol.for("hypheus.rehearsal.native.requests.v1");
    const now = Date.now();
    if (typeof request.requestid !== "string" || !/^[0-9a-f-]{36}$/.test(request.requestid) ||
        !Number.isSafeInteger(request.deadline) || request.deadline > now + 15000) fail("Invalid native request lease");
    const requests = globalThis[key] ??= new Map();
    for (const [id, entry] of requests) if (entry.deadline <= now && id !== request.requestid) requests.delete(id);
    let state = requests.get(request.requestid);
    const registered = Boolean(state);
    if (state && state.deadline !== request.deadline) fail("Native request lease changed");
    if (!state) {
        if (requests.size >= 256) fail("Native request inventory exceeds bound");
        state = { deadline: request.deadline, cancelled: false, started: false, capturestarted: false };
        requests.set(request.requestid, state);
    }
    if (request.operation === "cancel") {
        state.cancelled = true;
        // Tombstones survive cancel-before-dispatch until the absolute deadline.
        // Any original request arriving after expiry fails timely() regardless.
        return { requestid: request.requestid, cancelled: true, capturestarted: registered ? state.capturestarted : null };
    }
    function timely() {
        if (state.cancelled) fail("Native operation cancellation acknowledged");
        if (Date.now() >= request.deadline) fail("Native operation deadline exceeded");
    }
    if (state.started) fail("Duplicate native request");
    state.started = true;
    try {
    timely();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    function select() {
        timely();
        const windows = BaseWindow.getAllWindows();
        if (!Array.isArray(windows) || windows.length > 64) fail("Invalid native window inventory");
        const visible = windows.filter((win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.activeTabView);
        if (visible.length !== 1) fail("Expected exactly one visible native tab surface");
        const win = visible[0];
        const view = win.activeTabView;
        const wc = view.webContents;
        if (view.isDestroyed !== false || view.isActiveTab !== true || view.isInitialized !== true || view.isWaveReady !== true ||
            !win.contentView.getVisible() || !view.getVisible() || !win.contentView.children.includes(view) || !wc || wc.isDestroyed()) fail("Native tab is hidden, detached, destroyed or unready");
        if (!uuid.test(win.waveWindowId) || !uuid.test(view.waveTabId) || view.waveWindowId !== win.waveWindowId || wc.getURL() !== request.expectedurl || wc.isLoading()) fail("Native tab identity or URL mismatch");
        const bounds = view.getBounds();
        const content = win.getContentBounds();
        const display = screen.getDisplayMatching(content);
        const scale = display.scaleFactor;
        if (bounds.x !== 0 || bounds.y !== 0 || bounds.width !== content.width || bounds.height !== content.height ||
            !Number.isSafeInteger(content.width) || !Number.isSafeInteger(content.height) || content.width <= 0 || content.height <= 0 ||
            !Number.isSafeInteger(content.x) || !Number.isSafeInteger(content.y) || Math.abs(content.x) > 1000000 || Math.abs(content.y) > 1000000 ||
            !Number.isFinite(scale) || scale <= 0 || scale > 8) fail("Invalid native tab geometry");
        const width = Math.round(content.width * scale);
        const height = Math.round(content.height * scale);
        if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 16 * 1024 * 1024) fail("Native surface exceeds pixel bound");
        const frame = wc.mainFrame;
        const native = { windowid: win.waveWindowId, tabid: view.waveTabId, webcontentsid: wc.id,
            blockid: request.blockid, visible: true, width, height, x: content.x, y: content.y, scale,
            nativewindowid: win.id, displayid: display.id, dipwidth: content.width, dipheight: content.height,
            processid: frame.processId, routingid: frame.routingId, zoom: wc.getZoomFactor(), createdts: view.createdTs };
        if (request.pinned) {
            for (const key of Object.keys(native)) if (native[key] !== request.pinned[key]) fail("Pinned native identity or geometry changed");
        }
        return { win, view, wc, native };
    }
    const first = select();
    function sameNative() {
        const next = select();
        if (next.win !== first.win || next.view !== first.view || next.wc !== first.wc || JSON.stringify(next.native) !== JSON.stringify(first.native)) fail("Native surface replaced during inspection");
    }
    async function renderer() {
        const value = await first.wc.executeJavaScript(`(${function inspectRenderer() {
            const store = window.globalStore;
            const atoms = window.globalAtoms;
            const wrap = window.term;
            const term = wrap?.terminal;
            if (!store || !atoms || !window.WOS || !term) throw new Error("Renderer inspection hooks unavailable");
            const main = document.getElementById("main");
            const block = window.WOS.getObjectValue(`block:${wrap.blockId}`);
            const tab = window.WOS.getObjectValue(`tab:${wrap.tabId}`);
            const frame = term.element?.closest("[data-blockid]");
            const rect = frame?.getBoundingClientRect();
            function visible(element) {
                if (!element || !element.isConnected) return false;
                const r = element.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
                for (let cursor = element; cursor; cursor = cursor.parentElement) {
                    const style = getComputedStyle(cursor);
                    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
                }
                return true;
            }
            const terminals = document.querySelectorAll("[data-blockid] .xterm-helper-textarea");
            if (terminals.length > 256) throw new Error("Renderer terminal inventory exceeds bound");
            return { windowid: store.get(atoms.uiContext)?.windowid, tabid: store.get(atoms.staticTabId),
                wraptabid: wrap.tabId, blockid: wrap.blockId, frameid: frame?.getAttribute("data-blockid"),
                belongs: Array.isArray(tab?.blockids) && tab.blockids.includes(wrap.blockId),
                view: block?.meta?.view, controller: block?.meta?.controller, loaded: wrap.loaded === true,
                visible: document.visibilityState === "visible" && document.readyState !== "loading" && visible(main) && Boolean(main.childElementCount) && visible(frame),
                terminals: [...terminals].filter((el) => visible(el.closest("[data-blockid]"))).length,
                width: innerWidth, height: innerHeight, scale: devicePixelRatio, url: location.href, timeorigin: performance.timeOrigin,
                blockrect: rect ? [rect.x, rect.y, rect.width, rect.height] : null };
        }.toString()})()`, false);
        timely();
        sameNative();
        const native = first.native;
        if (!value || value.windowid !== native.windowid || value.tabid !== native.tabid || value.wraptabid !== native.tabid ||
            value.blockid !== request.blockid || value.frameid !== request.blockid || value.belongs !== true || value.view !== "term" || value.controller !== "shell" ||
            value.loaded !== true || value.visible !== true || value.terminals !== 1 || value.url !== request.expectedurl ||
            !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0 ||
            !Number.isFinite(value.scale) || Math.abs(value.scale - native.scale * native.zoom) > 0.00001 ||
            Math.abs(value.width * native.zoom - native.dipwidth) > native.zoom || Math.abs(value.height * native.zoom - native.dipheight) > native.zoom ||
            !Number.isFinite(value.timeorigin) || value.timeorigin <= 0 || !Array.isArray(value.blockrect) || value.blockrect.length !== 4 ||
            value.blockrect.some((n) => !Number.isFinite(n)) || value.blockrect[2] <= 0 || value.blockrect[3] <= 0) fail("Renderer does not match visible native terminal");
        if (request.pinned && value.timeorigin !== request.pinned.timeorigin) fail("Renderer document replaced");
        return value;
    }
    const before = await renderer();
    const target = { ...first.native, timeorigin: before.timeorigin };
    if (request.operation === "identity") return { target };
    if (request.operation !== "capture" || !Number.isSafeInteger(request.maxbytes) || request.maxbytes < 33 || request.maxbytes > 64 * 1024 * 1024) fail("Invalid capture request");
    timely();
    // capturePage already dispatched before main acknowledges cancellation cannot
    // be stopped. Checks guard every later dispatch, encode and IPC publication.
    state.capturestarted = true;
    const image = await first.wc.capturePage(undefined, { stayHidden: true, stayAwake: false });
    timely();
    sameNative();
    const after = await renderer();
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("Renderer identity or geometry changed during capture");
    if (!image || image.isEmpty()) fail("Empty native capture");
    const scales = image.getScaleFactors();
    if (!Array.isArray(scales) || scales.length !== 1 || scales[0] !== target.scale) fail("Unexpected native image scale representation");
    timely();
    const data = image.toPNG({ scaleFactor: target.scale });
    if (!Buffer.isBuffer(data) || data.length < 33 || data.length > request.maxbytes) fail("Native PNG exceeds byte bound or is empty");
    if (data.readUInt32BE(0) !== 0x89504e47 || data.readUInt32BE(4) !== 0x0d0a1a0a || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR" ||
        data.readUInt32BE(16) !== target.width || data.readUInt32BE(20) !== target.height) fail("Native PNG dimensions or header mismatch");
    timely();
    sameNative();
    return { target, bytes: data.length, png: data.toString("base64") };
    } finally {
        if (requests.get(request.requestid) === state) requests.delete(request.requestid);
    }
}

function validatedTarget(value) {
    const result = { ...snapshot(value) };
    if (!Uuid.test(result.windowid) || !Uuid.test(result.tabid) || !Uuid.test(result.blockid)) throw failure("IDENTITY", "Expected canonical native identities");
    integer(result.webcontentsid, "webcontentsid", 1, Number.MAX_SAFE_INTEGER);
    for (const key of ["nativewindowid", "processid", "routingid"]) result[key] = integer(value[key], key, 1, Number.MAX_SAFE_INTEGER);
    result.displayid = integer(value.displayid, "displayid", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    for (const key of ["dipwidth", "dipheight"]) result[key] = integer(value[key], key, 1, 16384);
    for (const key of ["timeorigin", "createdts", "zoom"]) {
        if (!Number.isFinite(value[key]) || value[key] <= 0) throw failure("IDENTITY", `Invalid native ${key}`);
        result[key] = value[key];
    }
    if (result.zoom > 8 || Math.round(result.dipwidth * result.scale) !== result.width || Math.round(result.dipheight * result.scale) !== result.height) throw failure("GEOMETRY", "Inconsistent native geometry");
    return Object.freeze(result);
}

function compare(expected, actual, keys) {
    for (const key of keys) if (expected[key] !== actual[key]) throw failure("IDENTITY", `Pinned target changed: ${key}`);
}

// Caller supplies an already-owned ElectronApplication; this module never launches,
// connects, submits input, writes files or installs dependencies. Visibility here
// cannot prove freedom from occlusion by other applications. Native bitmap/encoder
// allocation is pixel-bounded, not governed by maxbytes; PNG IPC is byte-bounded.
// WOS cache misses can initiate local object RPCs. Captures contain the entire tab,
// not just the pinned block: this adapter does not provide block privacy isolation.
// ABORT/TIMEOUT after dispatch carries cancellation=ACKNOWLEDGED only after main
// marks the request cancelled. Before that acknowledgement, capture can race the
// caller's signal. Missing acknowledgements return CANCEL_UNCONFIRMED instead.
// capturestarted=null means no retained dispatch history, not proof of no capture.
// A recorder racing its own timeout need not await this acknowledgement.
function createNativeAdapter({ app, expectedurl, blockid, timeoutms = 1000, canceltimeoutms = 1000 } = {}) {
    if (!app || typeof app.evaluate !== "function" || typeof expectedurl !== "string" || expectedurl.length > 4096 || !expectedurl.startsWith("file://") || !Uuid.test(blockid)) {
        throw failure("CONFIG", "Explicit Electron app, packaged file URL and canonical blockid are required");
    }
    integer(timeoutms, "timeoutms", 1, 15000);
    integer(canceltimeoutms, "canceltimeoutms", 1, 15000);
    let pinned;
    let busy = false;
    let sealed = false;
    async function operation(kind, { signal, maxbytes, target } = {}) {
        if (sealed) throw failure("STOPPED", "Native adapter is sealed after failure or cancellation");
        if (busy) throw failure("BUSY", "Native adapter operations must be serial");
        busy = true;
        let timer;
        let onabort;
        let dispatched = false;
        let cancellation;
        const request = { operation: kind, expectedurl, blockid, maxbytes, pinned, deadline: Date.now() + timeoutms, requestid: randomUUID() };
        async function acknowledge(code) {
            const error = failure(code, "Native operation cancelled");
            if (!dispatched) return Object.assign(error, { cancellation: "NOT_DISPATCHED", capturestarted: false });
            let cancellationtimer;
            try {
                const ack = await Promise.race([
                    Promise.resolve().then(() => app.evaluate(inspectNativeSurface, { ...request, operation: "cancel" })),
                    new Promise((resolve, reject) => { cancellationtimer = setTimeout(() => reject(new Error("Cancellation acknowledgement timed out")), canceltimeoutms); }),
                ]);
                if (ack?.requestid !== request.requestid || ack.cancelled !== true || !(ack.capturestarted === null || typeof ack.capturestarted === "boolean")) throw new Error("Invalid cancellation acknowledgement");
                return Object.assign(error, { cancellation: "ACKNOWLEDGED", capturestarted: ack.capturestarted });
            } catch {
                return Object.assign(failure("CANCEL_UNCONFIRMED", "Native cancellation acknowledgement unavailable; effective cancellation is indeterminate"), { cancellation: "INDETERMINATE", causecode: code });
            } finally {
                clearTimeout(cancellationtimer);
            }
        }
        try {
            if (signal?.aborted) throw failure("ABORT", "Native operation cancelled before dispatch");
            if (kind === "capture") {
                integer(maxbytes, "maxbytes", 33, 64 * 1024 * 1024);
                if (!pinned) throw failure("IDENTITY", "Inspect identity before capture");
                compare(pinned, snapshot(target), IdentityKeys);
            }
            const stop = new Promise((resolve, reject) => {
                const cancel = (code) => {
                    sealed = true;
                    cancellation ??= acknowledge(code);
                    cancellation.then(reject);
                };
                onabort = () => cancel("ABORT");
                signal?.addEventListener("abort", onabort, { once: true });
                timer = setTimeout(() => cancel("TIMEOUT"), timeoutms);
            });
            const envelope = await Promise.race([Promise.resolve().then(() => {
                if (signal?.aborted || cancellation) throw failure("ABORT", "Native operation cancelled before dispatch");
                dispatched = true;
                return app.evaluate(inspectNativeSurface, request);
            }), stop]);
            if (cancellation) throw await cancellation;
            if (signal?.aborted) throw failure("ABORT", "Native result cancelled");
            const actual = validatedTarget(envelope?.target);
            if (actual.blockid !== blockid) throw failure("IDENTITY", "Unexpected block identity");
            if (pinned) compare(pinned, actual, [...IdentityKeys, ...NativeKeys]);
            if (kind === "identity") {
                pinned ??= actual;
                return snapshot(actual);
            }
            const bytes = integer(envelope.bytes, "bytes", 33, maxbytes);
            if (typeof envelope.png !== "string" || envelope.png.length !== 4 * Math.ceil(bytes / 3)) throw failure("FRAME", "Invalid bounded PNG IPC envelope");
            const data = Buffer.from(envelope.png, "base64");
            if (data.length !== bytes || data.toString("base64") !== envelope.png || !data.subarray(0, 8).equals(Signature) ||
                data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR" || data.readUInt32BE(16) !== actual.width || data.readUInt32BE(20) !== actual.height) {
                throw failure("FRAME", "Invalid serialized native PNG");
            }
            return { data, width: actual.width, height: actual.height };
        } catch (error) {
            sealed = true;
            if (cancellation) throw await cancellation;
            throw error;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onabort);
            busy = false;
        }
    }
    return Object.freeze({ identity: (options) => operation("identity", options), capture: (options) => operation("capture", options) });
}

module.exports = { createNativeAdapter };
