// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Fs = require("node:fs/promises");
const Os = require("node:os");
const Path = require("node:path");
const { createHash } = require("node:crypto");
const { createStorage, GiB } = require("./lib/rehearsal-storage.cjs");
const { recordRehearsal, recorderConfig } = require("./lib/rehearsal-recorder.cjs");

// Synthetic buffers are ONLY unit-test input, never screenshots or film evidence.
function syntheticFrame(width = 8, height = 6, length = 64) {
    const data = Buffer.alloc(length);
    if (length >= 33) {
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
        data.writeUInt32BE(13, 8);
        data.write("IHDR", 12, "ascii");
        data.writeUInt32BE(width, 16);
        data.writeUInt32BE(height, 20);
    }
    return { data, width, height };
}

function identity() {
    return { windowid: 1, tabid: "test-tab", webcontentsid: 2, blockid: "test-block", visible: true, width: 8, height: 6, x: 0, y: 0, scale: 1 };
}

function fakeClock() {
    let now = 100;
    return {
        now: () => now,
        utc: () => new Date(1700000000000 + now).toISOString(),
        advance(ms) { now += ms; },
        async sleep(ms, signal) {
            if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
            now += ms;
        },
        setTimeout, clearTimeout,
    };
}

async function setup(t) {
    const root = await Fs.mkdtemp(Path.join(await Fs.realpath(Os.tmpdir()), "hypheus-recorder-unit-"));
    t.after(() => Fs.rm(root, { recursive: true, force: true }));
    const output = Path.join(root, "outputs");
    const profile = Path.join(root, "profile");
    const scratch = Path.join(root, "scratch");
    await Promise.all([output, profile, scratch].map((path) => Fs.mkdir(path)));
    const clock = fakeClock();
    const options = { roots: [output, profile, scratch], destination: Path.join(output, "run"), durationms: 250, intervalms: 100, timeoutms: 100, maxlagms: 25, maxframebytes: 4096 };
    const dependencies = {
        clock, identity,
        capture: async () => { clock.advance(2); return syntheticFrame(); },
        capacity: async () => ({ bsize: 4096n, bavail: BigInt(100 * GiB / 4096) }),
    };
    return { root, output, profile, scratch, options, dependencies, clock };
}

async function status(options) {
    return JSON.parse(await Fs.readFile(Path.join(options.destination, "status.json"), "utf8"));
}

async function outputs(options) {
    return Fs.readdir(options.destination);
}

test("finite strict recorder and storage limits cannot be relaxed", () => {
    assert.equal(recorderConfig({}).durationms, 15000);
    for (const field of ["durationms", "intervalms", "timeoutms", "maxlagms", "maxframebytes", "capbytes", "reservebytes"]) {
        for (const bad of [NaN, Infinity, -1, "10", 1.5]) assert.throws(() => recorderConfig({ [field]: bad }), /must be an integer/);
    }
    for (const config of [{ durationms: 15001 }, { capbytes: 2 * GiB + 1 }, { reservebytes: 20 * GiB - 1 }, { maxframebytes: 64 * 1024 * 1024 + 1 }, { intervalms: 16 }]) {
        assert.throws(() => recorderConfig(config));
    }
});

test("serial timed tab capture retains immutable originals, UTC/monotonic timestamps, and hashes", async (t) => {
    const { options, dependencies } = await setup(t);
    const result = await recordRehearsal(options, dependencies);
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.frames, 3);
    assert.equal(result.gaps, 0);
    assert.equal(result.mode, "timed-tab-surface-capture");
    assert.equal(result.achievedfps, 10);
    assert.equal(result.statuspublished, true);
    assert.equal((await status(options)).status, "COMPLETE");
    assert.equal(JSON.parse(await Fs.readFile(Path.join(options.destination, "manifest.json"))).status, "INCOMPLETE");
    let last = -Infinity;
    for (let index = 0; index < 3; index++) {
        const base = Path.join(options.destination, `frame-${String(index).padStart(6, "0")}`);
        const data = await Fs.readFile(`${base}.png`);
        const metadata = JSON.parse(await Fs.readFile(`${base}.json`));
        assert.equal(metadata.sha256, createHash("sha256").update(data).digest("hex"));
        assert.equal(metadata.width, 8);
        assert.equal(metadata.height, 6);
        assert.ok(metadata.started.mono >= last);
        assert.ok(metadata.captured.mono >= metadata.started.mono);
        assert.match(metadata.captured.utc, /Z$/);
        assert.equal((await Fs.stat(`${base}.png`)).mode & 0o222, 0);
        last = metadata.captured.mono;
    }
});

test("all disjoint roots and retained earlier runs consume the same allocation", async (t) => {
    const fixture = await setup(t);
    const previous = Path.join(fixture.output, "previous");
    await Fs.mkdir(previous);
    await Fs.writeFile(Path.join(previous, "retained.png"), Buffer.alloc(200000));
    await Fs.writeFile(Path.join(fixture.profile, "cache"), Buffer.alloc(200000));
    await Fs.writeFile(Path.join(fixture.scratch, "fixture"), Buffer.alloc(200000));
    fixture.options.capbytes = 700000;
    await assert.rejects(createStorage(fixture.options, fixture.dependencies), { code: "BUDGET" });
    assert.equal((await Fs.stat(Path.join(previous, "retained.png"))).size, 200000);
    await assert.rejects(Fs.stat(fixture.options.destination), { code: "ENOENT" });
});

test("disk reserve is enforced on every root, not only the output volume", async (t) => {
    const fixture = await setup(t);
    const checked = [];
    fixture.dependencies.capacity = async (root) => {
        checked.push(root);
        return { bsize: 1n, bavail: BigInt(root === fixture.scratch ? 20 * GiB : 100 * GiB) };
    };
    await assert.rejects(createStorage(fixture.options, fixture.dependencies), { code: "DISK_RESERVE" });
    assert.deepEqual(checked, fixture.options.roots);
});

test("existing destinations, overlap, duplicate roots, outside output, and symlinks are rejected", async (t) => {
    const fixture = await setup(t);
    await Fs.mkdir(fixture.options.destination);
    await Fs.writeFile(Path.join(fixture.options.destination, "keep"), "original");
    await assert.rejects(createStorage(fixture.options, fixture.dependencies), { code: "DESTINATION" });
    const fresh = { ...fixture.options, destination: Path.join(fixture.output, "fresh") };
    for (const roots of [[fixture.output, fixture.output], [fixture.output, fixture.options.destination]]) {
        await assert.rejects(createStorage({ ...fresh, roots }, fixture.dependencies), { code: "DESTINATION" });
    }
    await assert.rejects(createStorage({ ...fresh, destination: Path.join(fixture.root, "outside") }, fixture.dependencies), { code: "DESTINATION" });
    const link = Path.join(fixture.root, "link");
    await Fs.symlink(fixture.output, link);
    await assert.rejects(createStorage({ ...fresh, roots: [link], destination: Path.join(link, "new") }, fixture.dependencies), { code: "DESTINATION" });
    await Fs.symlink(fixture.profile, Path.join(fixture.scratch, "bad"));
    await assert.rejects(createStorage(fresh, fixture.dependencies), { code: "DESTINATION" });
    assert.equal(await Fs.readFile(Path.join(fixture.options.destination, "keep"), "utf8"), "original");
});

test("symlink destination and hard-linked retained files are rejected", async (t) => {
    const fixture = await setup(t);
    await Fs.symlink(fixture.profile, fixture.options.destination);
    await assert.rejects(createStorage(fixture.options, fixture.dependencies), { code: "DESTINATION" });
    fixture.options.destination = Path.join(fixture.output, "different");
    await Fs.writeFile(Path.join(fixture.profile, "one"), "unit");
    await Fs.link(Path.join(fixture.profile, "one"), Path.join(fixture.profile, "two"));
    await assert.rejects(createStorage(fixture.options, fixture.dependencies), { code: "DESTINATION" });
});

test("exclusive writes reject overwrites and retain original bytes", async (t) => {
    const fixture = await setup(t);
    const store = await createStorage(fixture.options, fixture.dependencies);
    await store.write("same.png", Buffer.from("original unit data"));
    await assert.rejects(store.write("same.png", Buffer.from("replacement")), { code: "EEXIST" });
    await assert.rejects(store.write("../escape", Buffer.from("no")), { code: "CONFIG" });
    assert.equal(await Fs.readFile(Path.join(fixture.options.destination, "same.png"), "utf8"), "original unit data");
    store.seal();
    await assert.rejects(store.write("next", Buffer.from("no")), { code: "BACKPRESSURE" });
});

test("capture failures and invalid buffers leave failure status, never zero-frame success", async (t) => {
    const cases = [
        async () => { throw new Error("unit capture failed"); },
        async () => syntheticFrame(8, 6, 0),
        async () => syntheticFrame(8, 6, 5000),
        async () => ({ ...syntheticFrame(), width: 0 }),
        async () => ({ ...syntheticFrame(), data: Buffer.alloc(64) }),
        async () => ({ ...syntheticFrame(9), width: 8 }),
    ];
    for (const capture of cases) {
        const fixture = await setup(t);
        fixture.dependencies.capture = capture;
        const result = await recordRehearsal(fixture.options, fixture.dependencies);
        assert.equal(result.status, "FAILED");
        assert.equal(result.frames, 0);
        assert.equal(result.gaps, 3);
        assert.equal((await status(fixture.options)).status, "FAILED");
        assert.ok((await outputs(fixture.options)).includes("manifest.json"));
    }
});

test("capture identity and native geometry changes stop before any frame write", async (t) => {
    for (const change of [{ tabid: "other" }, { webcontentsid: 44 }, { blockid: "other" }, { visible: false }, { width: 9 }, { height: 7 }, { x: 1 }, { scale: 2 }]) {
        const fixture = await setup(t);
        let calls = 0;
        fixture.dependencies.identity = () => ({ ...identity(), ...(++calls >= 3 ? change : {}) });
        const result = await recordRehearsal(fixture.options, fixture.dependencies);
        assert.equal(result.status, "FAILED");
        assert.equal(result.frames, 0);
        assert.equal((await outputs(fixture.options)).filter((file) => file.endsWith(".png")).length, 0);
    }
});

test("slow capture stops instead of catching up or starting concurrent captures", async (t) => {
    const fixture = await setup(t);
    let calls = 0;
    fixture.dependencies.capture = async () => { calls++; fixture.clock.advance(101); return syntheticFrame(); };
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.reason.code, "LATE");
    assert.equal(calls, 1);
    assert.equal(result.frames, 0);
    assert.equal(result.gaps, 3);
});

test("a capture that never settles times out and its eventual result cannot write", async (t) => {
    const fixture = await setup(t);
    fixture.options.timeoutms = 5;
    let release;
    let received;
    let calls = 0;
    fixture.dependencies.capture = ({ signal }) => {
        received = signal;
        calls++;
        return new Promise((resolve) => { release = resolve; });
    };
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.reason.code, "TIMEOUT");
    assert.equal(result.timeouts, 1);
    assert.equal(received.aborted, true);
    release(syntheticFrame());
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    assert.equal((await outputs(fixture.options)).length, 3);
});

test("abort before capture and during a pending capture persists ABORTED", async (t) => {
    for (const during of [false, true]) {
        const fixture = await setup(t);
        const controller = new AbortController();
        fixture.options.signal = controller.signal;
        let calls = 0;
        fixture.dependencies.capture = () => { calls++; controller.abort(); return new Promise(() => {}); };
        if (!during) controller.abort();
        const result = await recordRehearsal(fixture.options, fixture.dependencies);
        assert.equal(result.status, "ABORTED");
        assert.equal(result.reason.code, "ABORT");
        assert.equal(result.frames, 0);
        assert.equal(calls, during ? 1 : 0);
        assert.equal((await status(fixture.options)).status, "ABORTED");
    }
});

test("late timer wakeup counts lag and missing slots honestly", async (t) => {
    const fixture = await setup(t);
    fixture.clock.sleep = async (ms) => fixture.clock.advance(ms + 40);
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.reason.code, "LATE");
    assert.equal(result.frames, 1);
    assert.equal(result.gaps, 2);
    assert.equal(result.lagcount, 1);
    assert.equal(result.maxlagms, 40);
});

function withOpen(original, patch) {
    return Object.assign(Object.create(Fs), {
        async open(name, flags, mode) {
            const handle = await original.open(name, flags, mode);
            return patch(handle, name);
        },
    });
}

test("slow writes apply backpressure, never overlap capture, and keep committed frames", async (t) => {
    const fixture = await setup(t);
    let capturing = false;
    let writing = false;
    let captures = 0;
    fixture.dependencies.capture = async () => {
        assert.equal(writing, false);
        assert.equal(capturing, false);
        capturing = true;
        captures++;
        await Promise.resolve();
        capturing = false;
        return syntheticFrame();
    };
    fixture.dependencies.fs = withOpen(Fs, (handle, name) => ({
        async writeFile(data) {
            assert.equal(capturing, false);
            assert.equal(writing, false);
            writing = true;
            if (name.endsWith(".png")) fixture.clock.advance(101);
            await handle.writeFile(data);
            writing = false;
        },
        sync: () => handle.sync(), close: () => handle.close(),
    }));
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.reason.code, "BACKPRESSURE");
    assert.equal(result.frames, 1);
    assert.equal(captures, 1);
    assert.equal(result.gaps, 2);
    assert.ok((await outputs(fixture.options)).includes("frame-000000.png"));
});

test("partial write errors retain the incomplete original and a failure manifest", async (t) => {
    const fixture = await setup(t);
    fixture.dependencies.fs = withOpen(Fs, (handle, name) => ({
        async writeFile(data) {
            if (!name.endsWith(".png")) return handle.writeFile(data);
            await handle.writeFile(data.subarray(0, 17));
            throw Object.assign(new Error("unit device write error"), { code: "EIO" });
        },
        sync: () => handle.sync(), close: () => handle.close(),
    }));
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.reason.code, "EIO");
    assert.equal(result.frames, 0);
    assert.equal((await Fs.stat(Path.join(fixture.options.destination, "frame-000000.png"))).size, 17);
    assert.equal((await status(fixture.options)).status, "FAILED");
});

test("budget consumed during capture stops writes and preserves status headroom", async (t) => {
    const fixture = await setup(t);
    fixture.options.capbytes = 600000;
    fixture.dependencies.capture = async () => {
        await Fs.writeFile(Path.join(fixture.profile, "grew"), Buffer.alloc(300000));
        return syntheticFrame();
    };
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.reason.code, "BUDGET");
    assert.equal(result.frames, 0);
    assert.equal(result.statuspublished, true);
    assert.equal((await status(fixture.options)).reason.code, "BUDGET");
});

test("disk pressure after capture prevents frame writes but retains final status", async (t) => {
    const fixture = await setup(t);
    let captured = false;
    fixture.dependencies.capture = async () => { captured = true; return syntheticFrame(); };
    fixture.dependencies.capacity = async () => ({ bsize: 1n, bavail: BigInt(20 * GiB + (captured ? 200000 : GiB)) });
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.reason.code, "DISK_RESERVE");
    assert.equal(result.frames, 0);
    assert.equal(result.statuspublished, true);
});

test("unwritable final status cannot turn incomplete evidence into success", async (t) => {
    const fixture = await setup(t);
    fixture.dependencies.fs = Object.assign(Object.create(Fs), {
        async open(name, ...args) {
            if (name.endsWith("status.pending.json")) throw Object.assign(new Error("unit failure"), { code: "EIO" });
            return Fs.open(name, ...args);
        },
    });
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.status, "FAILED");
    assert.equal(result.statuspublished, false);
    assert.equal(result.initialmanifestpreserved, true);
    assert.equal(JSON.parse(await Fs.readFile(Path.join(fixture.options.destination, "manifest.json"))).status, "INCOMPLETE");
    assert.equal((await outputs(fixture.options)).filter((name) => name.endsWith(".png")).length, 3);
});

test("storage write serialization refuses concurrent callers", async (t) => {
    const fixture = await setup(t);
    let release;
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    fixture.dependencies.fs = withOpen(Fs, (handle) => ({
        async writeFile(data) {
            entered();
            await new Promise((resolve) => { release = resolve; });
            return handle.writeFile(data);
        },
        sync: () => handle.sync(), close: () => handle.close(),
    }));
    const store = await createStorage(fixture.options, fixture.dependencies);
    const first = store.write("first", Buffer.from("unit"));
    await ready;
    await assert.rejects(store.write("second", Buffer.from("unit")), { code: "BACKPRESSURE" });
    release();
    await first;
});

test("abort during write drains that write and retains original plus metadata before stopping", async (t) => {
    const fixture = await setup(t);
    const controller = new AbortController();
    fixture.options.signal = controller.signal;
    fixture.dependencies.fs = withOpen(Fs, (handle, name) => ({
        async writeFile(data) {
            if (name.endsWith(".png")) controller.abort();
            await handle.writeFile(data);
        },
        sync: () => handle.sync(), close: () => handle.close(),
    }));
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.status, "ABORTED");
    assert.equal(result.frames, 1);
    assert.equal(result.gaps, 2);
    assert.ok((await outputs(fixture.options)).includes("frame-000000.json"));
    assert.equal((await status(fixture.options)).status, "ABORTED");
});

test("changed output directory identity is rejected without writing into its replacement", async (t) => {
    const fixture = await setup(t);
    const store = await createStorage(fixture.options, fixture.dependencies);
    await store.write("original", Buffer.from("retained unit data"));
    const retained = Path.join(fixture.output, "retained");
    await Fs.rename(fixture.options.destination, retained);
    await Fs.mkdir(fixture.options.destination);
    await assert.rejects(store.write("new", Buffer.from("no")), { code: "DESTINATION" });
    assert.equal(await Fs.readFile(Path.join(retained, "original"), "utf8"), "retained unit data");
    assert.deepEqual(await outputs(fixture.options), []);
});

test("a retained first frame survives a later capture failure with exact gap count", async (t) => {
    const fixture = await setup(t);
    let calls = 0;
    fixture.dependencies.capture = async () => {
        if (++calls === 2) throw new Error("unit second-frame failure");
        return syntheticFrame();
    };
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.status, "FAILED");
    assert.equal(result.frames, 1);
    assert.equal(result.gaps, 2);
    assert.equal(result.firstmissedindex, 1);
    assert.ok((await outputs(fixture.options)).includes("frame-000000.png"));
    assert.equal((await status(fixture.options)).frames, 1);
});

test("memory-only nested filesystem double rejects both destination ancestry and inventory mounts", async () => {
    for (const destination of ["/estate/mounted/run", "/estate/run"]) {
        let mkdircalls = 0;
        const stat = (dev, ino) => ({ dev, ino, size: 0, blocks: 0, mode: 0o700, nlink: 1, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false });
        const fs = {
            async lstat(name) {
                if (name.endsWith("/run")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
                return stat(name.startsWith("/estate/mounted") ? 2 : 1, name);
            },
            async opendir(name) {
                return { async *[Symbol.asyncIterator]() { if (name === "/estate") yield { name: "mounted" }; } };
            },
            async mkdir() { mkdircalls++; },
        };
        await assert.rejects(createStorage({ roots: ["/estate"], destination }, { fs, capacity: async (name) => ({ bsize: 1n, bavail: BigInt(name.includes("mounted") ? GiB : 100 * GiB) }) }), { code: "FILESYSTEM" });
        assert.equal(mkdircalls, 0);
    }
});

test("each prepublication persistence failure leaves only nonauthoritative status and originals", async (t) => {
    for (const point of ["stagewrite", "stagesync", "stageclose", "diropen", "dirsync", "dirclose", "link"]) {
        const fixture = await setup(t);
        const error = () => Object.assign(new Error(`unit ${point}`), { code: "EIO" });
        fixture.dependencies.fs = Object.assign(Object.create(Fs), {
            async open(name, flags, mode) {
                const stage = name.endsWith("status.pending.json");
                const dir = name === fixture.options.destination;
                if (dir && point === "diropen") throw error();
                const handle = await Fs.open(name, flags, mode);
                return {
                    async writeFile(data) {
                        if (stage && point === "stagewrite") { await handle.writeFile(data.subarray(0, 17)); throw error(); }
                        return handle.writeFile(data);
                    },
                    async sync() {
                        if ((stage && point === "stagesync") || (dir && point === "dirsync")) throw error();
                        return handle.sync();
                    },
                    async close() {
                        await handle.close();
                        if ((stage && point === "stageclose") || (dir && point === "dirclose")) throw error();
                    },
                };
            },
            async link(from, to) { if (point === "link") throw error(); return Fs.link(from, to); },
        });
        const result = await recordRehearsal(fixture.options, fixture.dependencies);
        assert.equal(result.status, "FAILED", point);
        assert.equal(result.statuspublished, false, point);
        assert.equal(result.publication, point === "link" ? "INDETERMINATE" : "NOT_PUBLISHED");
        await assert.rejects(Fs.lstat(Path.join(fixture.options.destination, "status.json")), { code: "ENOENT" });
        assert.equal((await outputs(fixture.options)).filter((name) => name.endsWith(".png")).length, 3);
        assert.equal(JSON.parse(await Fs.readFile(Path.join(fixture.options.destination, "manifest.json"))).status, "INCOMPLETE");
        assert.ok((await outputs(fixture.options)).includes("status.pending.json"));
    }
});

test("exclusive status publication preserves an existing final target", async (t) => {
    const fixture = await setup(t);
    fixture.dependencies.fs = Object.assign(Object.create(Fs), {
        async link(from, to) {
            await Fs.writeFile(to, "existing unit original", { flag: "wx" });
            return Fs.link(from, to);
        },
    });
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.status, "FAILED");
    assert.equal(result.publication, "INDETERMINATE");
    assert.equal(result.manifesterror.code, "EEXIST");
    assert.equal(await Fs.readFile(Path.join(fixture.options.destination, "status.json"), "utf8"), "existing unit original");
});

test("publication acknowledgement failure explicitly reports ambiguity, never claimed durability", async (t) => {
    const fixture = await setup(t);
    fixture.dependencies.fs = Object.assign(Object.create(Fs), {
        async link(from, to) { await Fs.link(from, to); throw Object.assign(new Error("unit lost acknowledgement"), { code: "EIO" }); },
    });
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.status, "FAILED");
    assert.equal(result.publication, "INDETERMINATE");
    const record = await status(fixture.options);
    assert.equal(record.status, "COMPLETE");
    assert.equal(record.finalization.completion, "RUNTIME_ONLY");
    assert.equal(record.finalization.durability, "UNCONFIRMED");
});

test("retained published status pairs are readonly, counted twice, and permit a second run", async (t) => {
    const fixture = await setup(t);
    const first = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(first.status, "COMPLETE");
    assert.equal(first.publication, "PUBLISHED_RUNTIME");
    assert.equal(first.finalization.durability, "UNCONFIRMED");
    const staged = await Fs.stat(Path.join(fixture.options.destination, "status.pending.json"));
    const published = await Fs.stat(Path.join(fixture.options.destination, "status.json"));
    assert.equal(staged.ino, published.ino);
    assert.equal(staged.nlink, 2);
    assert.equal(staged.mode & 0o222, 0);
    const store = await createStorage({ ...fixture.options, destination: Path.join(fixture.output, "second") }, fixture.dependencies);
    const budget = await store.check();
    let expected = 0;
    async function count(name) {
        const stat = await Fs.lstat(name);
        expected += Math.max(stat.size, stat.blocks * 512);
        if (stat.isDirectory()) for (const child of await Fs.readdir(name)) await count(Path.join(name, child));
    }
    for (const root of fixture.options.roots) await count(root);
    assert.equal(budget.usedbytes, expected);
    assert.ok(expected >= 2 * Math.max(staged.size, staged.blocks * 512));
    const second = await recordRehearsal({ ...fixture.options, destination: Path.join(fixture.output, "third") }, fixture.dependencies);
    assert.equal(second.status, "COMPLETE");
});

test("malformed, writable, and third-link status pairs remain forbidden", async (t) => {
    for (const kind of ["malformed", "writable", "thirdlink"]) {
        const fixture = await setup(t);
        const prior = Path.join(fixture.output, "prior");
        await Fs.mkdir(prior);
        const staged = Path.join(prior, "status.pending.json");
        const published = Path.join(prior, "status.json");
        await Fs.writeFile(staged, "unit", { mode: 0o400 });
        await Fs.link(staged, kind === "malformed" ? Path.join(prior, "not-status.json") : published);
        if (kind === "writable") await Fs.chmod(staged, 0o600);
        if (kind === "thirdlink") await Fs.link(staged, Path.join(prior, "third"));
        await assert.rejects(createStorage(fixture.options, fixture.dependencies), { code: "DESTINATION" });
    }
});

test("second-slot failures report the current missing index after a committed first frame", async (t) => {
    for (const cause of ["late", "identity", "abort", "storage"]) {
        const fixture = await setup(t);
        const controller = new AbortController();
        fixture.options.signal = controller.signal;
        let second = false;
        fixture.clock.sleep = async (ms) => {
            second = true;
            fixture.clock.advance(ms + (cause === "late" ? 40 : 0));
            if (cause === "abort") controller.abort();
        };
        fixture.dependencies.identity = () => ({ ...identity(), ...(second && cause === "identity" ? { tabid: "changed" } : {}) });
        fixture.dependencies.capacity = async () => ({ bsize: 1n, bavail: BigInt(20 * GiB + (second && cause === "storage" ? 200000 : GiB)) });
        const result = await recordRehearsal(fixture.options, fixture.dependencies);
        assert.equal(result.frames, 1, cause);
        assert.equal(result.gaps, 2, cause);
        assert.equal(result.firstmissedindex, 1, cause);
        assert.equal(result.attempts, 1, cause);
    }
});

test("clock regressions cannot produce successful timing evidence", async (t) => {
    const fixture = await setup(t);
    fixture.dependencies.capture = async () => { fixture.clock.advance(-5); return syntheticFrame(); };
    const result = await recordRehearsal(fixture.options, fixture.dependencies);
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason.code, "CLOCK");
    assert.equal(result.frames, 0);
});
