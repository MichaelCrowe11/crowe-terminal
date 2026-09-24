// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const Path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createHash } = require("node:crypto");
const { createNativeAdapter } = require("./rehearsal-native-adapter.cjs");
const { recordRehearsal, recorderConfig, snapshot } = require("./rehearsal-recorder.cjs");
const { verifyFixture } = require("./rehearsal-fixture.cjs");
const { failure, integer } = require("./rehearsal-storage.cjs");

const Preconditions = ["externallyowned", "startupisolated", "minimalenvironment", "nomodel", "handsoff", "tabprivacyreviewed", "completestorageroots"];
const Hash = /^[a-f0-9]{64}$/;

function absolute(value) {
    if (typeof value !== "string" || !Path.isAbsolute(value) || Path.resolve(value) !== value) throw failure("CONFIG", "Expected normalized absolute path");
    return value;
}
function contains(root, value) {
    return value === root || value.startsWith(root + Path.sep);
}
function problem(error) {
    return { code: error?.code ?? "ERROR", message: String(error?.message ?? error).slice(0, 1024) };
}
function fixtureIdentity(files) {
    return createHash("sha256").update(JSON.stringify(files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })).sort((a, b) => a.name.localeCompare(b.name)))).digest("hex");
}
function validate(options, now) {
    integer(now, "now", 0, Number.MAX_SAFE_INTEGER);
    if (!options || options.mode !== "offline-passive-no-model") throw failure("CONFIG", "Only explicit offline-passive-no-model mode is accepted");
    const allowed = ["mode", "lease", "artifact", "fixture", "estate", "destination", "recording", "expectedurl", "preconditions", "draintimeoutms", "adaptertimeoutms", "canceltimeoutms"];
    if (Object.keys(options).some((key) => !allowed.includes(key))) throw failure("CONFIG", "Unknown controller option; no action or prompt hooks are supported");
    if (!Preconditions.every((key) => options.preconditions?.[key] === true)) throw failure("PRECONDITION", "Explicit external provisioning attestations are required");
    const lease = options.lease;
    if (!lease || typeof lease.id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(lease.id) || typeof lease.owner !== "string" || !lease.owner.trim() || lease.owner.length > 256) throw failure("LEASE", "Explicit bounded owned lease required");
    integer(lease.issuedms, "issuedms", 0, Number.MAX_SAFE_INTEGER);
    integer(lease.expiresms, "expiresms", 0, Number.MAX_SAFE_INTEGER);
    if (lease.issuedms > now || lease.expiresms <= now || lease.expiresms - lease.issuedms > 60000) throw failure("LEASE", "Lease is expired, future-dated or exceeds 60 seconds");
    const target = snapshot(lease.target);
    const artifact = options.artifact;
    if (!artifact || !Hash.test(artifact.sha256) || artifact.kind !== "development" || typeof artifact.revision !== "string" || !artifact.revision || artifact.revision.length > 256 || lease.artifactsha256 !== artifact.sha256) throw failure("ARTIFACT", "Lease must identify the development artifact and revision");
    absolute(artifact.path);
    if (typeof options.expectedurl !== "string" || lease.expectedurl !== options.expectedurl || !contains(artifact.path, absolute(fileURLToPath(options.expectedurl)))) throw failure("ARTIFACT", "Pinned file URL must belong to the leased artifact");
    const fixture = options.fixture;
    if (!fixture || !Array.isArray(fixture.baseline) || fixture.baseline.length !== 3) throw failure("FIXTURE", "Prepared three-file fixture baseline required");
    absolute(fixture.directory);
    if (lease.fixturedirectory !== fixture.directory || lease.fixturesha256 !== fixtureIdentity(fixture.baseline)) throw failure("FIXTURE", "Fixture does not match lease");
    const estate = options.estate;
    if (!estate || !Array.isArray(estate.roots) || estate.roots.length < 1 || estate.roots.length > 32) throw failure("CONFIG", "Complete retained estate roots required");
    const roots = estate.roots.map(absolute);
    roots.forEach((root, i) => {
        if (roots.slice(0, i).some((other) => contains(root, other) || contains(other, root))) throw failure("CONFIG", "Estate roots must be disjoint");
    });
    for (const value of [fixture.directory, absolute(estate.profile), absolute(estate.scratch), absolute(options.destination)]) {
        if (!roots.some((root) => contains(root, value))) throw failure("CONFIG", "Fixture, profile, scratch and output must belong to the measured estate");
    }
    if (contains(fixture.directory, estate.profile) || contains(fixture.directory, options.destination) || contains(estate.profile, fixture.directory)) throw failure("FIXTURE", "Profile/output must be outside the neutral fixture cwd");
    const recording = options.recording ?? {};
    if (Object.keys(recording).some((key) => !["durationms", "intervalms", "timeoutms", "maxlagms", "maxframebytes", "capbytes", "reservebytes"].includes(key))) throw failure("CONFIG", "Unknown recording option");
    const config = recorderConfig(recording);
    const draintimeoutms = integer(options.draintimeoutms ?? 1000, "draintimeoutms", 1, 15000);
    const adaptertimeoutms = integer(options.adaptertimeoutms ?? 1000, "adaptertimeoutms", 1, 15000);
    const canceltimeoutms = integer(options.canceltimeoutms ?? 1000, "canceltimeoutms", 1, 15000);
    if (now + config.durationms + config.timeoutms + draintimeoutms >= lease.expiresms) throw failure("LEASE", "Lease does not cover capture and bounded drain");
    return { roots, config, target, draintimeoutms, adaptertimeoutms, canceltimeoutms };
}

// This is an offline library, not a launch/isolation CLI. The caller must supply an
// already externally owned app, audited no-model startup/environment, complete estate,
// hands-off/privacy confirmation, and a read-only artifact inspector bound to that app.
// inspectArtifact() must independently measure the loaded artifact's path/hash/revision;
// echoing the requested identity is not verification. Attestations and the lease document
// are NOT an OS lock, network sandbox, or proof of these external preconditions.
// The adapter captures the entire tab, not the whole window or a privacy-isolated block.
// No lease is released here. STOPPED describes only tracked controller operations.
function createRehearsalController(options, dependencies = {}) {
    const now = dependencies.now ?? Date.now;
    const config = validate(options, now());
    // Snapshot authority inputs so caller mutation cannot expand a running lease.
    const input = JSON.parse(JSON.stringify(options));
    const { app, inspectArtifact } = dependencies;
    if (!app || typeof app.evaluate !== "function" || typeof inspectArtifact !== "function") throw failure("CONFIG", "Owned app and independent read-only artifact inspector required");
    const abort = new AbortController();
    const native = [];
    const operations = [];
    const cancellations = [];
    const pending = new Set();
    let running = false;
    let finished = false;
    let result;
    let expiry;
    let stopreason;
    function track(list, row, invoke) {
        list.push(row);
        const original = Promise.resolve().then(invoke);
        pending.add(original);
        // Retain the original promise separately from the recorder's timeout race.
        original.then(() => { row.state = "FULFILLED"; pending.delete(original); }, (error) => {
            row.state = "REJECTED";
            row.error = problem(error);
            if (error?.cancellation) row.cancellation = { status: error.cancellation, capturestarted: error.capturestarted ?? null };
            pending.delete(original);
        });
        return original;
    }
    const transport = {
        evaluate(fn, request) {
            const row = { requestid: request.requestid, operation: request.operation, state: "PENDING" };
            const list = request.operation === "cancel" ? cancellations : native;
            return track(list, row, async () => {
                if (request.operation !== "cancel") active();
                const value = await app.evaluate(fn, request);
                if (request.operation === "cancel") row.ack = { requestid: value?.requestid, cancelled: value?.cancelled, capturestarted: value?.capturestarted ?? null };
                return value;
            });
        },
    };
    const adapter = createNativeAdapter({ app: transport, expectedurl: input.expectedurl, blockid: config.target.blockid, timeoutms: config.adaptertimeoutms, canceltimeoutms: config.canceltimeoutms });
    function stop(reason = "REQUESTED") {
        stopreason ??= reason;
        abort.abort();
        return status();
    }
    function safeNative(row) {
        if (row.state === "PENDING") return false;
        if (row.state === "FULFILLED") return true;
        // A successful cancel only prevents later dispatch. true/null never proves
        // an already-started capturePage has completed, even if the adapter settled.
        return cancellations.some((cancel) => cancel.state === "FULFILLED" && cancel.ack?.requestid === row.requestid && cancel.ack.cancelled === true && cancel.ack.capturestarted === false);
    }
    function status() {
        const unknown = native.some((row) => !safeNative(row)) || operations.some((row) => row.state === "PENDING") || cancellations.some((row) => row.state === "PENDING");
        return JSON.parse(JSON.stringify({ phase: finished ? "FINISHED" : running ? "RUNNING" : "PREPARED", stopstate: unknown ? "UNKNOWN" : running ? "RUNNING" : "STOPPED", holdlease: running || unknown, leasereleased: false, stopreason, native, operations, cancellations }));
    }
    function active() {
        if (now() >= input.lease.expiresms) stop("LEASE_EXPIRED");
        if (abort.signal.aborted) throw failure("ABORT", "Controller stopped or lease expired");
    }
    async function artifact() {
        const observed = await inspectArtifact();
        for (const key of ["path", "sha256", "revision", "kind"]) if (observed?.[key] !== input.artifact[key]) throw failure("ARTIFACT", `Observed artifact mismatch: ${key}`);
        return { ...input.artifact };
    }
    function call(kind, args) {
        active();
        return track(operations, { operation: kind, state: "PENDING" }, async () => {
            const value = await adapter[kind](args);
            if (kind === "identity") for (const key of Object.keys(config.target)) if (value[key] !== config.target[key]) throw failure("IDENTITY", `Lease target mismatch: ${key}`);
            return value;
        });
    }
    async function drain() {
        let timer;
        try {
            await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => { timer = setTimeout(resolve, config.draintimeoutms); })]);
        } finally { clearTimeout(timer); }
    }
    async function run() {
        if (running || finished) throw failure("STOPPED", "Controller is single use");
        running = true;
        result = { version: 1, mode: input.mode, status: "FAILED", leaseid: input.lease.id, originals: "retained; no deletion or overwrite", publication: "MEMORY_ONLY", fixture: {}, artifact: {}, errors: [], limitations: "Externally attested isolation; lease is not an OS lock; tab-surface only; no model/proposal proof; no full decode" };
        expiry = setTimeout(() => stop("LEASE_EXPIRED"), Math.max(1, input.lease.expiresms - now()));
        try {
            active();
            result.artifact.before = await artifact();
            result.fixture.before = await verifyFixture(input.fixture.directory, input.fixture.baseline);
            active();
            result.recorder = await recordRehearsal({ ...config.config, roots: config.roots, destination: input.destination, signal: abort.signal }, {
                fs: dependencies.fs, capacity: dependencies.capacity, clock: dependencies.clock,
                identity: (args) => call("identity", args), capture: (args) => call("capture", args),
            });
        } catch (error) { result.errors.push(problem(error)); }
        finally {
            abort.abort();
            await drain();
            // Postflight is attempted even after storage/capture failure; it never
            // overwrites the recorder's original manifests with a controller verdict.
            try { result.fixture.after = await verifyFixture(input.fixture.directory, input.fixture.baseline); }
            catch (error) { result.errors.push({ ...problem(error), stage: "fixtureafter" }); }
            try { result.artifact.after = await artifact(); }
            catch (error) { result.errors.push({ ...problem(error), stage: "artifactafter" }); }
            // Timer delivery can lag synchronous work and microtasks. Completion
            // authority must check the deadline itself after all postflight awaits.
            if (now() >= input.lease.expiresms) {
                stop("LEASE_EXPIRED");
                result.errors.push({ code: "LEASE_EXPIRED", message: "Lease expired before controller completion", stage: "completion" });
            }
            clearTimeout(expiry);
            running = false;
            finished = true;
        }
        const state = status();
        result.status = result.errors.length === 0 && result.recorder?.status === "COMPLETE" && result.recorder.statuspublished === true && state.stopstate === "STOPPED" && !stopreason ? "COMPLETE" : "FAILED";
        result.control = state;
        // A returned receipt is a historical snapshot. status() can later show a
        // genuine native result settling, but never retroactively promotes failure.
        return JSON.parse(JSON.stringify(result));
    }
    return Object.freeze({ run, stop, status });
}

module.exports = { createRehearsalController, fixtureIdentity };
