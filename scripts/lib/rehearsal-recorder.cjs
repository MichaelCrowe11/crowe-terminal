// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { setTimeout: sleep } = require("node:timers/promises");
const { createStorage, storageConfig, failure, integer } = require("./rehearsal-storage.cjs");

const DefaultClock = {
    now: () => performance.now(), utc: () => new Date().toISOString(),
    sleep: (ms, signal) => sleep(ms, null, { signal }),
    setTimeout, clearTimeout,
};
const Signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function recorderConfig(options) {
    const config = {
        ...storageConfig(options),
        durationms: integer(options.durationms ?? 15000, "durationms", 1, 15000),
        intervalms: integer(options.intervalms ?? 100, "intervalms", 17, 15000),
        timeoutms: integer(options.timeoutms ?? 1000, "timeoutms", 1, 15000),
        maxlagms: integer(options.maxlagms ?? 25, "maxlagms", 0, 1000),
        maxframebytes: integer(options.maxframebytes ?? 16 * 1024 * 1024, "maxframebytes", 33, 64 * 1024 * 1024),
    };
    return Object.freeze(config);
}

// width/height are native pixel dimensions; x/y and scale must also be revalidated
// by the adapter. visible means the genuine target tab is the selected visible tab.
function snapshot(value) {
    if (!value || value.visible !== true) throw failure("IDENTITY", "Target is not a verified visible tab");
    const result = {};
    for (const key of ["windowid", "tabid", "webcontentsid", "blockid"]) {
        const id = value[key];
        if (!((typeof id === "string" && id.length > 0 && id.length <= 256) || (Number.isSafeInteger(id) && id >= 0))) {
            throw failure("IDENTITY", `Missing or invalid ${key}`);
        }
        result[key] = id;
    }
    for (const key of ["width", "height"]) result[key] = integer(value[key], key, 1, 16384);
    if (result.width * result.height > 16 * 1024 * 1024) throw failure("GEOMETRY", "Native surface pixel count exceeds limit");
    for (const key of ["x", "y"]) result[key] = integer(value[key], key, -1000000, 1000000);
    if (!Number.isFinite(value.scale) || value.scale <= 0 || value.scale > 8) throw failure("GEOMETRY", "Invalid surface scale");
    result.scale = value.scale;
    result.visible = true;
    return Object.freeze(result);
}

function sameTarget(expected, actual) {
    for (const key of ["windowid", "tabid", "webcontentsid", "blockid", "visible"]) {
        if (expected[key] !== actual[key]) throw failure("IDENTITY", "Visible target identity changed");
    }
    for (const key of ["width", "height", "x", "y", "scale"]) {
        if (expected[key] !== actual[key]) throw failure("GEOMETRY", "Native target geometry changed");
    }
}

function frameBuffer(frame, target, maxbytes) {
    if (!frame || !Buffer.isBuffer(frame.data) || frame.data.length < 33 || frame.data.length > maxbytes) {
        throw failure("FRAME", "Capture must return a nonempty bounded PNG Buffer");
    }
    const { data, width, height } = frame;
    integer(width, "nativewidth", 1, 16384);
    integer(height, "nativeheight", 1, 16384);
    if (width !== target.width || height !== target.height) throw failure("GEOMETRY", "Captured native dimensions changed");
    if (!data.subarray(0, 8).equals(Signature) || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR" || data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) {
        throw failure("FRAME", "PNG header disagrees with captured native dimensions");
    }
    return data;
}

function json(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`);
}

// capture({signal,maxbytes,target}) returns {data: PNG Buffer,width,height}.
// The adapter must bound its own allocation, transfer exclusive Buffer ownership,
// and perform no output writes. Electron capturePage itself is not cancellable;
// after timeout its result is ignored and no next capture is ever started.
// identity({signal}) must inspect the actual native target, not a cached UI claim.
// This is timed tab-surface capture, NOT a presentation subscription, desktop,
// whole-window, audio recorder, or a guarantee that every presented frame is seen.
async function recordRehearsal(options, dependencies) {
    const config = recorderConfig(options);
    if (!dependencies || typeof dependencies.capture !== "function" || typeof dependencies.identity !== "function") {
        throw failure("CONFIG", "Explicit capture and native identity adapters are required");
    }
    const clock = dependencies.clock ?? DefaultClock;
    for (const method of ["now", "utc", "sleep", "setTimeout", "clearTimeout"]) {
        if (typeof clock[method] !== "function") throw failure("CONFIG", `Clock requires ${method}`);
    }
    const signal = options.signal;
    const store = await createStorage({ ...options, ...config }, dependencies);
    let lastmono = -Infinity;
    function stamp() {
        const mono = clock.now();
        const utc = clock.utc();
        if (!Number.isFinite(mono) || mono < lastmono || typeof utc !== "string" || !Number.isFinite(Date.parse(utc))) {
            throw failure("CLOCK", "Clock must provide nondecreasing monotonic milliseconds and valid UTC");
        }
        lastmono = mono;
        return { mono, utc: new Date(utc).toISOString() };
    }
    function aborted() {
        if (signal?.aborted) throw failure("ABORT", "Recording aborted");
    }
    async function bounded(operation, timeoutms) {
        aborted();
        const controller = new AbortController();
        let timer;
        let onabort;
        try {
            const stopped = new Promise((resolve, reject) => {
                onabort = () => {
                    controller.abort();
                    reject(failure("ABORT", "Recording aborted"));
                };
                signal?.addEventListener("abort", onabort, { once: true });
                timer = clock.setTimeout(() => {
                    controller.abort();
                    reject(failure("TIMEOUT", "Capture or identity inspection timed out"));
                }, timeoutms);
            });
            // The losing promise has a rejection handler via race; it cannot write
            // files or schedule another frame after cancellation.
            return await Promise.race([Promise.resolve().then(() => {
                if (controller.signal.aborted) throw failure("ABORT", "Operation cancelled before dispatch");
                return operation(controller.signal);
            }), stopped]);
        } finally {
            clock.clearTimeout(timer);
            signal?.removeEventListener("abort", onabort);
        }
    }
    const summary = {
        version: 1, mode: "timed-tab-surface-capture", status: "INCOMPLETE", config,
        frames: 0, attempts: 0, gaps: 0, lagcount: 0, maxlagms: 0,
        captureerrors: 0, timeouts: 0, bytes: 0,
        originals: "retained; no deletion or overwrite", validation: "native dimensions and PNG IHDR; full decode not performed",
    };
    let initialwritten = false;
    let origin;
    let next = 0;
    let deadline;
    let inflight = false;
    let committed = false;
    try {
        summary.started = stamp();
        await store.write("manifest.json", json(summary));
        initialwritten = true;
        aborted();
        const target = snapshot(await bounded((sig) => dependencies.identity({ signal: sig }), config.timeoutms));
        summary.target = target;
        origin = stamp().mono;
        summary.originmono = origin;
        deadline = origin + config.durationms;
        summary.deadlinemono = deadline;
        const total = Math.ceil(config.durationms / config.intervalms);
        summary.scheduledframes = total;
        for (let index = 0; index < total; index++) {
            next = index;
            committed = false;
            inflight = false;
            const scheduled = origin + index * config.intervalms;
            const wait = scheduled - stamp().mono;
            if (wait > 0) await clock.sleep(wait, signal);
            aborted();
            const current = stamp();
            const lag = Math.max(0, current.mono - scheduled);
            summary.maxlagms = Math.max(summary.maxlagms, lag);
            if (lag > 0) summary.lagcount++;
            if (lag > config.maxlagms || current.mono >= deadline) throw failure("LATE", "Timed capture start missed its allowed slot");
            await store.check(config.maxframebytes);
            const before = snapshot(await bounded((sig) => dependencies.identity({ signal: sig }), Math.min(config.timeoutms, Math.max(1, deadline - stamp().mono))));
            sameTarget(target, before);
            aborted();
            const started = stamp();
            const capturedeadline = Math.min(deadline, scheduled + config.intervalms);
            if (started.mono >= capturedeadline || started.mono - scheduled > config.maxlagms) throw failure("LATE", "Pre-capture checks exhausted the capture slot");
            summary.attempts++;
            inflight = true;
            committed = false;
            const frame = await bounded((sig) => dependencies.capture({ signal: sig, maxbytes: config.maxframebytes, target }), Math.min(config.timeoutms, capturedeadline - started.mono));
            const captured = stamp();
            aborted();
            if (captured.mono >= capturedeadline) throw failure("LATE", "Capture completed after its slot deadline");
            const data = frameBuffer(frame, target, config.maxframebytes);
            sameTarget(target, snapshot(await bounded((sig) => dependencies.identity({ signal: sig }), Math.min(config.timeoutms, Math.max(1, capturedeadline - captured.mono)))));
            if (stamp().mono >= capturedeadline) throw failure("LATE", "Post-capture validation exhausted the capture slot");
            aborted();
            const name = `frame-${String(index).padStart(6, "0")}`;
            const sha256 = createHash("sha256").update(data).digest("hex");
            const budget = await store.write(`${name}.png`, data);
            // Once a write starts it is drained, never raced against abort: a partial
            // write is retained, and final status cannot race an outstanding write.
            await store.write(`${name}.json`, json({ index, scheduledmono: scheduled, started, captured, width: frame.width, height: frame.height, bytes: data.length, sha256, budget }));
            summary.frames++;
            summary.bytes += data.length;
            summary.firstcapture ??= captured;
            summary.lastcapture = captured;
            committed = true;
            inflight = false;
            aborted();
            if (stamp().mono >= capturedeadline) throw failure("BACKPRESSURE", "Serial frame write exhausted the capture slot");
            next = index + 1;
        }
        if (summary.frames === 0) throw failure("ZERO_FRAMES", "No frames recorded");
        summary.status = "COMPLETE";
    } catch (error) {
        const code = error.code === "ABORT_ERR" ? "ABORT" : (error.code ?? "CAPTURE_ERROR");
        summary.status = code === "ABORT" ? "ABORTED" : "FAILED";
        summary.reason = { code, message: String(error.message ?? error).slice(0, 1024) };
        summary.captureerrors = inflight && !committed ? 1 : 0;
        summary.timeouts = code === "TIMEOUT" ? 1 : 0;
        summary.gaps = Math.max(0, (summary.scheduledframes ?? 0) - summary.frames);
        summary.firstmissedindex = summary.gaps > 0 ? (committed ? next + 1 : next) : null;
    }
    try {
        summary.ended = stamp();
    } catch (error) {
        summary.status = "FAILED";
        summary.reason = { code: "CLOCK", message: error.message };
    }
    summary.achievedfps = summary.firstcapture && summary.lastcapture && summary.lastcapture.mono > summary.firstcapture.mono
        ? (summary.frames - 1) * 1000 / (summary.lastcapture.mono - summary.firstcapture.mono) : null;
    summary.finalization = {
        authority: "status.json only; status.pending.json is nonauthoritative and must be ignored",
        completion: "RUNTIME_ONLY", durability: "UNCONFIRMED",
        protocol: "content sync and close, prepublication directory sync and close, exclusive link; no postpublication durability claim",
    };
    try {
        await store.finalize(json(summary));
        summary.statuspublished = true;
        summary.publication = "PUBLISHED_RUNTIME";
    } catch (error) {
        // The immutable initial manifest remains INCOMPLETE if even the reserved
        // final write fails (device loss, permissions, or external disk consumption).
        summary.statuspublished = false;
        summary.publication = error.publication ?? "NOT_PUBLISHED";
        summary.status = "FAILED";
        summary.manifesterror = { code: error.code ?? "WRITE_ERROR", message: String(error.message).slice(0, 1024) };
        summary.initialmanifestpreserved = initialwritten;
    } finally {
        store.seal();
    }
    return summary;
}

module.exports = { recordRehearsal, recorderConfig, snapshot };
