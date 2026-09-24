// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ExpectedNames = ["draft.txt", "input.txt", "review.txt"];
const MaximumFixtureBytes = 64 * 1024;

async function canonicalDirectory(directory) {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
        throw new Error("Directory must be an absolute normalized path");
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) {
        throw new Error("Directory must be canonical and contain no symlink components");
    }
}

function validateBaseline(baseline) {
    if (!Array.isArray(baseline) || baseline.length !== ExpectedNames.length) {
        throw new Error("Expected exactly three baseline records");
    }
    if (JSON.stringify(baseline.map((row) => row.name).sort()) !== JSON.stringify(ExpectedNames)) {
        throw new Error("Unexpected fixture filenames");
    }
    let total = 0;
    for (const row of baseline) {
        if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) {
            throw new Error("Invalid fixture baseline");
        }
        total += row.bytes;
    }
    if (total > MaximumFixtureBytes) throw new Error("Fixture exceeds preparation limit");
}

async function readFixture(directory, baseline) {
    validateBaseline(baseline);
    await canonicalDirectory(directory);
    const names = (await fs.readdir(directory)).sort();
    if (JSON.stringify(names) !== JSON.stringify(ExpectedNames)) throw new Error("Fixture entry set changed");
    const records = [];
    for (const name of names) {
        const expected = baseline.find((row) => row.name === name);
        const entry = await fs.lstat(path.join(directory, name));
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Invalid fixture file: ${name}`);
        const handle = await fs.open(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const before = await handle.stat();
            if (!before.isFile() || before.size !== expected.bytes) throw new Error(`Invalid fixture file: ${name}`);
            const data = Buffer.alloc(expected.bytes);
            let offset = 0;
            while (offset < data.length) {
                const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
                if (!bytesRead) throw new Error(`Truncated fixture file: ${name}`);
                offset += bytesRead;
            }
            const after = await handle.stat();
            const current = await fs.lstat(path.join(directory, name));
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
                current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev) {
                throw new Error(`Fixture changed while reading: ${name}`);
            }
            const sha256 = crypto.createHash("sha256").update(data).digest("hex");
            if (sha256 !== expected.sha256) throw new Error(`Fixture hash mismatch: ${name}`);
            records.push({ name, bytes: data.length, sha256, data });
        } finally {
            await handle.close();
        }
    }
    await canonicalDirectory(directory);
    if (JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(ExpectedNames)) {
        throw new Error("Fixture entry set changed while reading");
    }
    return records;
}

async function verifyFixture(directory, baseline) {
    return (await readFixture(directory, baseline)).map(({ data, ...record }) => record);
}

async function prepareFixture({ source, destination, baseline }) {
    const records = await readFixture(source, baseline);
    await canonicalDirectory(path.dirname(destination));
    if (!path.isAbsolute(destination) || path.resolve(destination) !== destination) {
        throw new Error("Destination must be an absolute normalized path");
    }
    // Failed preparations remain inspectable; never remove existing or partial evidence.
    await fs.mkdir(destination, { mode: 0o700 });
    for (const record of records) {
        const handle = await fs.open(path.join(destination, record.name), "wx", 0o600);
        try {
            await handle.writeFile(record.data);
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    const result = await verifyFixture(destination, baseline);
    await verifyFixture(source, baseline);
    return { directory: destination, files: result, scope: "filesystem preparation only; no application action" };
}

module.exports = { prepareFixture, verifyFixture };
