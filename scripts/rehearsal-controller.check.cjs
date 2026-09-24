// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Fs = require("node:fs/promises");
const Os = require("node:os");
const Path = require("node:path");
const { createHash } = require("node:crypto");
const { createRehearsalController, fixtureIdentity } = require("./lib/rehearsal-controller.cjs");

const Target = {
    windowid: "11111111-1111-4111-8111-111111111111", tabid: "22222222-2222-4222-8222-222222222222", blockid: "33333333-3333-4333-8333-333333333333",
    webcontentsid: 1, visible: true, width: 2, height: 2, x: 0, y: 0, scale: 1,
    nativewindowid: 1, displayid: 1, dipwidth: 2, dipheight: 2, processid: 1, routingid: 1, timeorigin: 1, zoom: 1, createdts: 1,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
// Synthetic header-only PNG for UNIT tests only, never app or film evidence.
function envelope() {
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12);
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(2, 20);
    return { target: Target, bytes: png.length, png: png.toString("base64") };
}
async function setup(t, dispatch) {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "hypheus-controller-unit-")));
    t.after(() => Fs.rm(root, { recursive: true, force: true }));
    const fixture = Path.join(root, "fixture");
    await Fs.mkdir(fixture);
    await Fs.mkdir(Path.join(root, "profile"));
    const baseline = [];
    for (const name of ["draft.txt", "input.txt", "review.txt"]) {
        const data = Buffer.from(`UNIT fictional fixture ${name}\n`);
        await Fs.writeFile(Path.join(fixture, name), data);
        baseline.push({ name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
    const artifact = { path: Path.join(root, "unit-development-app"), sha256: "a".repeat(64), revision: "UNIT-ONLY", kind: "development" };
    const expectedurl = `file://${artifact.path}/index.html`;
    const options = {
        mode: "offline-passive-no-model", artifact, expectedurl,
        lease: { id: "unit-lease", owner: "UNIT", issuedms: Date.now(), expiresms: Date.now() + 50000, artifactsha256: artifact.sha256, fixturedirectory: fixture, fixturesha256: fixtureIdentity(baseline), expectedurl, target: { ...Target } },
        fixture: { directory: fixture, baseline }, estate: { roots: [root], profile: Path.join(root, "profile"), scratch: root }, destination: Path.join(root, "recording"),
        preconditions: { externallyowned: true, startupisolated: true, minimalenvironment: true, nomodel: true, handsoff: true, tabprivacyreviewed: true, completestorageroots: true },
        recording: { durationms: 100, intervalms: 100, timeoutms: 10, maxframebytes: 100 }, adaptertimeoutms: 500, canceltimeoutms: 15, draintimeoutms: 35,
    };
    const calls = [];
    let mono = 0;
    const dependencies = {
        app: { evaluate: async (fn, request) => {
            calls.push(request.operation);
            if (dispatch) return dispatch(request);
            if (request.operation === "identity") return { target: Target };
            if (request.operation === "capture") return envelope();
            return { requestid: request.requestid, cancelled: true, capturestarted: false };
        } },
        inspectArtifact: async () => ({ ...artifact }), capacity: async () => ({ bsize: 4096n, bavail: 100000000n }),
        clock: { now: () => mono, utc: () => new Date().toISOString(), sleep: async (ms) => { mono += ms; }, setTimeout, clearTimeout },
    };
    return { options, dependencies, calls, root, fixture };
}

test("normal passive run uses reviewed modules, retains originals and verifies fixture twice", async (t) => {
    const { options, dependencies, calls, root } = await setup(t);
    const controller = createRehearsalController(options, dependencies);
    const result = await controller.run();
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.control.stopstate, "STOPPED");
    assert.equal(result.control.holdlease, false);
    assert.equal(result.control.leasereleased, false);
    assert.deepEqual(result.fixture.before, result.fixture.after);
    assert.deepEqual(result.recorder.config.capbytes, 2 * 1024 ** 3);
    assert.deepEqual(calls, ["identity", "identity", "capture", "identity"]);
    assert.equal((await Fs.readFile(Path.join(root, "recording", "frame-000000.png"))).length, 33);
    assert.equal(JSON.parse(await Fs.readFile(Path.join(root, "recording", "manifest.json"))).status, "INCOMPLETE");
    await assert.rejects(controller.run(), { code: "STOPPED" });
});

test("rejects missing/expired/unbounded lease, model options, incomplete preconditions and fixture/artifact mismatch before transport", async (t) => {
    const { options, dependencies, calls } = await setup(t);
    const changes = [
        (o) => { delete o.lease; }, (o) => { o.lease.expiresms = 1; }, (o) => { o.lease.expiresms += 100000; },
        (o) => { o.mode = "live"; }, (o) => { o.prompt = "do something"; }, (o) => { o.command = "pwd"; },
        (o) => { delete o.preconditions.startupisolated; }, (o) => { o.artifact.sha256 = "b".repeat(64); },
        (o) => { o.fixture.baseline[0].sha256 = "b".repeat(64); }, (o) => { o.estate.profile = "/outside"; },
        (o) => { o.recording.signal = {}; }, (o) => { o.expectedurl += "?other"; },
    ];
    for (const change of changes) {
        const copy = structuredClone(options);
        change(copy);
        assert.throws(() => createRehearsalController(copy, dependencies));
    }
    assert.deepEqual(calls, []);
});

test("observed artifact mismatch and unexpected fixture entry prohibit native access", async (t) => {
    const unit = await setup(t);
    const result = await createRehearsalController(unit.options, { ...unit.dependencies, inspectArtifact: async () => ({ ...unit.options.artifact, sha256: "b".repeat(64) }) }).run();
    assert.equal(result.status, "FAILED");
    assert.equal(result.errors[0].code, "ARTIFACT");
    await Fs.writeFile(Path.join(unit.fixture, "extra.txt"), "UNIT");
    const second = await createRehearsalController(unit.options, unit.dependencies).run();
    assert.equal(second.status, "FAILED");
    assert.deepEqual(unit.calls, []);
});

test("postflight fixture or artifact change fails controller without rewriting recorder evidence", async (t) => {
    const unit = await setup(t);
    let inspections = 0;
    unit.dependencies.inspectArtifact = async () => {
        inspections++;
        if (inspections === 2) {
            await Fs.writeFile(Path.join(unit.fixture, "input.txt"), "changed");
            return { ...unit.options.artifact, sha256: "b".repeat(64) };
        }
        return unit.options.artifact;
    };
    const result = await createRehearsalController(unit.options, unit.dependencies).run();
    assert.equal(result.status, "FAILED");
    assert.equal(result.recorder.status, "COMPLETE");
    assert.equal(result.errors.at(-1).stage, "artifactafter");
    assert.equal(JSON.parse(await Fs.readFile(Path.join(unit.options.destination, "status.json"))).status, "COMPLETE");
});

for (const capturestarted of [false, true, null]) {
    test(`recorder timeout retains original pending native capture after cancellation ack ${capturestarted}`, async (t) => {
        const capture = deferred();
        const unit = await setup(t, (request) => {
            if (request.operation === "capture") return capture.promise;
            if (request.operation === "cancel") return { requestid: request.requestid, cancelled: true, capturestarted };
            return { target: Target };
        });
        const controller = createRehearsalController(unit.options, unit.dependencies);
        const result = await controller.run();
        assert.equal(result.status, "FAILED");
        assert.equal(result.recorder.reason.code, "TIMEOUT");
        assert.equal(result.control.stopstate, "UNKNOWN");
        assert.equal(result.control.holdlease, true);
        assert.equal(result.control.cancellations[0].ack.capturestarted, capturestarted);
        assert.equal(result.control.operations.find((r) => r.operation === "capture").cancellation.status, "ACKNOWLEDGED");
        capture.reject(new Error("UNIT delayed native rejection"));
        await delay(0);
        assert.equal(controller.status().holdlease, capturestarted !== false);
        assert.equal(result.control.holdlease, true);
    });
}

test("unconfirmed cancellation remains unknown even when adapter settles; bounded drain observes late promise", async (t) => {
    const capture = deferred();
    const cancel = deferred();
    const unit = await setup(t, (request) => request.operation === "capture" ? capture.promise : request.operation === "cancel" ? cancel.promise : { target: Target });
    const controller = createRehearsalController(unit.options, unit.dependencies);
    const start = Date.now();
    const result = await controller.run();
    assert.ok(Date.now() - start < 2000);
    assert.equal(result.control.stopstate, "UNKNOWN");
    assert.equal(result.control.operations.find((r) => r.operation === "capture").error.code, "CANCEL_UNCONFIRMED");
    capture.reject(new Error("UNIT late capture failure"));
    cancel.reject(new Error("UNIT late cancellation failure"));
    await delay(0);
    assert.equal(controller.status().holdlease, true);
});

test("drain timeout can precede adapter cancellation settlement without unhandled rejection", async (t) => {
    const capture = deferred();
    const cancel = deferred();
    let cancelrequest;
    const unit = await setup(t, (request) => {
        if (request.operation === "capture") return capture.promise;
        if (request.operation === "cancel") { cancelrequest = request; return cancel.promise; }
        return { target: Target };
    });
    unit.options.draintimeoutms = 2;
    unit.options.canceltimeoutms = 100;
    const controller = createRehearsalController(unit.options, unit.dependencies);
    const result = await controller.run();
    assert.equal(result.control.operations.at(-1).state, "PENDING");
    assert.equal(result.control.holdlease, true);
    cancel.resolve({ requestid: cancelrequest.requestid, cancelled: true, capturestarted: true });
    capture.resolve(envelope());
    await delay(0);
    assert.equal(controller.status().stopstate, "STOPPED");
    assert.equal(result.status, "FAILED");
});

test("storage floor, existing destination and publication errors preserve honest failure", async (t) => {
    const unit = await setup(t);
    const low = await createRehearsalController(unit.options, { ...unit.dependencies, capacity: async () => ({ bsize: 4096n, bavail: 1n }) }).run();
    assert.equal(low.status, "FAILED");
    assert.equal(low.errors[0].code, "DISK_RESERVE");
    assert.deepEqual(unit.calls, []);
    await Fs.mkdir(unit.options.destination);
    await Fs.writeFile(Path.join(unit.options.destination, "original.txt"), "UNIT retained");
    const exists = await createRehearsalController(unit.options, unit.dependencies).run();
    assert.equal(exists.errors[0].code, "DESTINATION");
    assert.equal(await Fs.readFile(Path.join(unit.options.destination, "original.txt"), "utf8"), "UNIT retained");
    unit.options.destination = Path.join(unit.root, "publication-error");
    const fs = Object.create(Fs);
    fs.link = async () => { throw Object.assign(new Error("UNIT publication failure"), { code: "EIO" }); };
    const publication = await createRehearsalController(unit.options, { ...unit.dependencies, fs }).run();
    assert.equal(publication.status, "FAILED");
    assert.equal(publication.recorder.statuspublished, false);
    assert.ok(await Fs.stat(Path.join(unit.options.destination, "frame-000000.png")));
});

test("external stop during capture never equates acknowledged cancellation with completion", async (t) => {
    const started = deferred();
    const capture = deferred();
    const unit = await setup(t, (request) => {
        if (request.operation === "capture") { started.resolve(); return capture.promise; }
        if (request.operation === "cancel") return { requestid: request.requestid, cancelled: true, capturestarted: true };
        return { target: Target };
    });
    const controller = createRehearsalController(unit.options, unit.dependencies);
    const run = controller.run();
    await started.promise;
    assert.equal(controller.stop().holdlease, true);
    const result = await run;
    assert.equal(result.status, "FAILED");
    assert.equal(result.control.stopstate, "UNKNOWN");
    capture.resolve(envelope());
    await delay(0);
    assert.equal(controller.status().stopstate, "STOPPED");
});

test("all retained roots are measured and symlink destinations rejected", async (t) => {
    const unit = await setup(t);
    const output = Path.join(unit.root, "output");
    await Fs.mkdir(output);
    unit.options.estate = { roots: [unit.fixture, Path.join(unit.root, "profile"), output], scratch: unit.fixture, profile: Path.join(unit.root, "profile") };
    unit.options.destination = Path.join(output, "run");
    const measured = new Set();
    const result = await createRehearsalController(unit.options, { ...unit.dependencies, capacity: async (root) => { measured.add(root); return { bsize: 4096n, bavail: 100000000n }; } }).run();
    assert.equal(result.status, "COMPLETE");
    assert.deepEqual([...measured].sort(), unit.options.estate.roots.sort());
    unit.options.destination = Path.join(output, "link");
    await Fs.symlink(unit.fixture, unit.options.destination);
    const symlink = await createRehearsalController(unit.options, unit.dependencies).run();
    assert.equal(symlink.status, "FAILED");
    assert.equal(symlink.errors[0].code, "DESTINATION");
});

test("frame storage write error retains partial originals and fails receipt", async (t) => {
    const unit = await setup(t);
    const fs = Object.create(Fs);
    fs.open = async (name, ...args) => {
        const handle = await Fs.open(name, ...args);
        if (name.endsWith(".png")) handle.writeFile = async () => { throw Object.assign(new Error("UNIT write failure"), { code: "EIO" }); };
        return handle;
    };
    const result = await createRehearsalController(unit.options, { ...unit.dependencies, fs }).run();
    assert.equal(result.status, "FAILED");
    assert.equal(result.recorder.reason.code, "EIO");
    assert.equal((await Fs.stat(Path.join(unit.options.destination, "frame-000000.png"))).size, 0);
});

test("fixture changes during capture fail postflight while original frame remains", async (t) => {
    let fixture;
    const unit = await setup(t, async (request) => {
        if (request.operation === "capture") {
            await Fs.writeFile(Path.join(fixture, "input.txt"), "UNIT changed contents");
            return envelope();
        }
        return { target: Target };
    });
    fixture = unit.fixture;
    const result = await createRehearsalController(unit.options, unit.dependencies).run();
    assert.equal(result.status, "FAILED");
    assert.equal(result.recorder.status, "COMPLETE");
    assert.equal(result.errors[0].stage, "fixtureafter");
    assert.ok(await Fs.stat(Path.join(unit.options.destination, "frame-000000.png")));
});

test("lease expires during fixture checks and target mismatch prevent capture", async (t) => {
    const unit = await setup(t);
    let now = unit.options.lease.issuedms;
    const expires = await createRehearsalController(unit.options, { ...unit.dependencies, now: () => now, inspectArtifact: async () => { now = unit.options.lease.expiresms; return unit.options.artifact; } }).run();
    assert.equal(expires.status, "FAILED");
    assert.equal(expires.control.stopreason, "LEASE_EXPIRED");
    assert.deepEqual(unit.calls, []);
    unit.options.lease.target.width = 3;
    const mismatch = await createRehearsalController(unit.options, unit.dependencies).run();
    assert.equal(mismatch.recorder.reason.code, "IDENTITY");
    assert.ok(!unit.calls.includes("capture"));
});

for (const offset of [0, 1]) {
    test(`postflight microtask expiry at deadline +${offset} fails before delayed timer delivery`, async (t) => {
        const unit = await setup(t);
        let current = unit.options.lease.issuedms;
        let inspections = 0;
        let timerdelivered = false;
        let queuedtimer;
        t.after(() => clearTimeout(queuedtimer));
        unit.dependencies.now = () => current;
        unit.dependencies.inspectArtifact = async () => {
            if (++inspections === 2) {
                queuedtimer = setTimeout(() => { timerdelivered = true; }, 0);
                await Promise.resolve();
                current = unit.options.lease.expiresms + offset;
            }
            return { ...unit.options.artifact };
        };
        const controller = createRehearsalController(unit.options, unit.dependencies);
        const result = await controller.run();
        assert.equal(timerdelivered, false, "postflight/completion ran in microtasks before timers");
        assert.equal(result.recorder.status, "COMPLETE");
        assert.deepEqual(result.artifact.before, result.artifact.after);
        assert.equal(result.status, "FAILED");
        assert.equal(result.control.stopreason, "LEASE_EXPIRED");
        assert.equal(result.errors.at(-1).code, "LEASE_EXPIRED");
        assert.equal(result.errors.at(-1).stage, "completion");
        assert.equal(result.control.leasereleased, false);
        assert.equal(result.control.stopstate, "STOPPED");
        assert.equal(result.control.holdlease, false, "all native operations completed; expiry does not invent native uncertainty");
        assert.equal(JSON.parse(await Fs.readFile(Path.join(unit.options.destination, "status.json"))).status, "COMPLETE");
    });
}

test("postflight lease expiry preserves pending-native UNKNOWN and lease hold", async (t) => {
    const capture = deferred();
    const unit = await setup(t, (request) => {
        if (request.operation === "capture") return capture.promise;
        if (request.operation === "cancel") return { requestid: request.requestid, cancelled: true, capturestarted: true };
        return { target: Target };
    });
    let current = unit.options.lease.issuedms;
    let inspections = 0;
    unit.dependencies.now = () => current;
    unit.dependencies.inspectArtifact = async () => {
        if (++inspections === 2) current = unit.options.lease.expiresms + 1;
        return { ...unit.options.artifact };
    };
    const controller = createRehearsalController(unit.options, unit.dependencies);
    const result = await controller.run();
    assert.equal(result.status, "FAILED");
    assert.equal(result.control.stopreason, "LEASE_EXPIRED");
    assert.equal(result.control.stopstate, "UNKNOWN");
    assert.equal(result.control.holdlease, true);
    assert.equal(result.errors.at(-1).code, "LEASE_EXPIRED");
    capture.reject(new Error("UNIT late capture failure after lease expiry"));
    await delay(0);
    assert.equal(controller.status().stopstate, "UNKNOWN");
    assert.equal(controller.status().holdlease, true);
});
