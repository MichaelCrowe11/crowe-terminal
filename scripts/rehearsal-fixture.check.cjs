// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { prepareFixture, verifyFixture } = require("./lib/rehearsal-fixture.cjs");

async function setup(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hypheus-fixture-unit-")));
    t.after(() => fs.rm(root, { recursive: true }));
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const baseline = [];
    for (const name of ["draft.txt", "input.txt", "review.txt"]) {
        const data = Buffer.from(`Synthetic unit-test fixture: ${name}\n`);
        await fs.writeFile(path.join(source, name), data, { flag: "wx" });
        baseline.push({ name, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
    }
    return { root, source, destination: path.join(root, "fixture"), baseline };
}

test("copies exactly three files and verifies both endpoints", async (t) => {
    const options = await setup(t);
    const before = await verifyFixture(options.source, options.baseline);
    const result = await prepareFixture(options);
    assert.deepEqual(result.files, before);
    assert.deepEqual(await verifyFixture(options.source, options.baseline), before);
    assert.deepEqual(await fs.readdir(options.destination), ["draft.txt", "input.txt", "review.txt"]);
    assert.match(result.scope, /no application action/);
});

test("never overwrites an existing destination", async (t) => {
    const options = await setup(t);
    await fs.mkdir(options.destination);
    await fs.writeFile(path.join(options.destination, "owner.txt"), "preserve");
    await assert.rejects(prepareFixture(options), { code: "EEXIST" });
    assert.equal(await fs.readFile(path.join(options.destination, "owner.txt"), "utf8"), "preserve");
});

test("rejects unexpected hidden entries before creating output", async (t) => {
    const options = await setup(t);
    await fs.writeFile(path.join(options.source, ".hidden"), "test");
    await assert.rejects(prepareFixture(options), /entry set/);
    await assert.rejects(fs.stat(options.destination), { code: "ENOENT" });
});

test("rejects changed content even when byte count matches", async (t) => {
    const options = await setup(t);
    await fs.writeFile(path.join(options.source, "draft.txt"), Buffer.alloc(options.baseline[0].bytes, 65));
    await assert.rejects(prepareFixture(options), /hash mismatch/);
});

test("rejects a symlink file", async (t) => {
    const options = await setup(t);
    await fs.rename(path.join(options.source, "draft.txt"), path.join(options.root, "original.txt"));
    await fs.symlink(path.join(options.root, "original.txt"), path.join(options.source, "draft.txt"));
    await assert.rejects(prepareFixture(options));
});

test("rejects symlink source directories and destination parents", async (t) => {
    const options = await setup(t);
    const alias = path.join(options.root, "alias");
    await fs.symlink(options.source, alias);
    await assert.rejects(prepareFixture({ ...options, source: alias }), /canonical/);
    await assert.rejects(prepareFixture({ ...options, destination: path.join(alias, "fixture") }), /canonical/);
});

test("post-state verification detects size and entry changes", async (t) => {
    const options = await setup(t);
    await prepareFixture(options);
    await fs.appendFile(path.join(options.destination, "review.txt"), "changed");
    await assert.rejects(verifyFixture(options.destination, options.baseline), /Invalid fixture/);
});

test("rejects traversal, duplicate names and excessive baselines", async (t) => {
    const options = await setup(t);
    await assert.rejects(prepareFixture({ ...options, baseline: options.baseline.map((r) => ({ ...r, name: "../escape" })) }), /filenames/);
    await assert.rejects(prepareFixture({ ...options, baseline: options.baseline.map((r) => ({ ...r, bytes: 100000 })) }), /limit/);
    await assert.rejects(prepareFixture({ ...options, destination: `${options.root}/x/../fixture` }), /canonical|normalized|ENOENT/);
});
