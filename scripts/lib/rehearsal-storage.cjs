// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const Fs = require("node:fs/promises");
const { constants: Flags } = require("node:fs");
const Path = require("node:path");

const GiB = 1024 ** 3;
const FinalAllowance = 256 * 1024;
const FileOverhead = 64 * 1024;

function failure(code, message) {
    return Object.assign(new Error(message), { code });
}

function integer(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw failure("CONFIG", `${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

function storageConfig(options) {
    return {
        capbytes: integer(options.capbytes ?? 2 * GiB, "capbytes", 1, 2 * GiB),
        reservebytes: integer(options.reservebytes ?? 20 * GiB, "reservebytes", 20 * GiB, Number.MAX_SAFE_INTEGER),
    };
}

function contains(root, file) {
    const relative = Path.relative(root, file);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative));
}

async function directory(fs, name, boundary) {
    const absolute = Path.resolve(name);
    let cursor = Path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(Path.sep).filter(Boolean)) {
        cursor = Path.join(cursor, part);
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw failure("DESTINATION", `Directory must not contain symlinks or non-directories: ${cursor}`);
        }
        if (boundary && contains(boundary.root, cursor) && stat.dev !== boundary.dev) {
            throw failure("FILESYSTEM", "Nested filesystem boundaries are not allowed inside storage roots");
        }
    }
    return fs.lstat(absolute);
}

async function finalizationPair(fs, name, stat) {
    const base = Path.basename(name);
    if (stat.nlink !== 2 || (stat.mode & 0o222) !== 0 || !["status.json", "status.pending.json"].includes(base)) return false;
    const other = Path.join(Path.dirname(name), base === "status.json" ? "status.pending.json" : "status.json");
    try {
        const peer = await fs.lstat(other);
        return peer.isFile() && !peer.isSymbolicLink() && peer.nlink === 2 && (peer.mode & 0o222) === 0 && peer.dev === stat.dev && peer.ino === stat.ino;
    } catch {
        return false;
    }
}

async function measure(fs, roots, owners) {
    let bytes = 0;
    let entries = 0;
    async function walk(name, depth, dev) {
        if (++entries > 100000 || depth > 64) {
            throw failure("SCAN_LIMIT", "Storage inventory exceeds bounded scan limits");
        }
        const stat = await fs.lstat(name);
        if (stat.dev !== dev) throw failure("FILESYSTEM", "Nested filesystem boundaries are not allowed inside storage roots");
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1 && !await finalizationPair(fs, name, stat))) {
            throw failure("DESTINATION", `Storage contains a symlink, special file, or unrecognized hard link: ${name}`);
        }
        const allocated = Math.max(stat.size, (stat.blocks ?? 0) * 512);
        if (!Number.isSafeInteger(allocated) || !Number.isSafeInteger(bytes + allocated)) {
            throw failure("CAPACITY", "Invalid storage allocation measurement");
        }
        bytes += allocated;
        if (!stat.isDirectory()) return;
        const handle = await fs.opendir(name);
        for await (const entry of handle) await walk(Path.join(name, entry.name), depth + 1, dev);
    }
    for (let index = 0; index < roots.length; index++) await walk(roots[index], 0, owners[index].dev);
    return bytes;
}

// Roots must be the complete retained rehearsal estate, not only this run's directory.
// Callers must exclusively own the directories: Node lacks portable openat-based protection
// against a hostile concurrent ancestor rename, and capacity checks are not disk quotas.
async function createStorage(options, dependencies = {}) {
    const fs = dependencies.fs ?? Fs;
    const capacity = dependencies.capacity ?? ((root) => fs.statfs(root, { bigint: true }));
    const config = storageConfig(options);
    if (!Array.isArray(options.roots) || options.roots.length < 1 || options.roots.length > 32) {
        throw failure("CONFIG", "Pass between 1 and 32 existing disjoint storage roots");
    }
    const roots = options.roots.map((root) => {
        if (typeof root !== "string" || !Path.isAbsolute(root)) throw failure("CONFIG", "Storage roots must be absolute paths");
        return Path.resolve(root);
    });
    for (let i = 0; i < roots.length; i++) {
        for (let j = 0; j < i; j++) {
            if (contains(roots[i], roots[j]) || contains(roots[j], roots[i])) {
                throw failure("DESTINATION", "Storage roots must be disjoint, with no duplicates or overlaps");
            }
        }
    }
    if (typeof options.destination !== "string" || !Path.isAbsolute(options.destination)) {
        throw failure("CONFIG", "Destination must be an absolute new directory");
    }
    const destination = Path.resolve(options.destination);
    if (!roots.some((root) => root !== destination && contains(root, destination))) {
        throw failure("DESTINATION", "Destination must be strictly inside a declared storage root");
    }
    const owners = await Promise.all(roots.map((root) => directory(fs, root)));
    const outputindex = roots.findIndex((root) => contains(root, destination));
    const boundary = { root: roots[outputindex], dev: owners[outputindex].dev };
    await directory(fs, Path.dirname(destination), boundary);
    try {
        await fs.lstat(destination);
        throw failure("DESTINATION", "Destination already exists; originals must not be overwritten");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    let outputowner;
    let busy = false;
    let sealed = false;
    async function check(bytes = 0, final = false) {
        integer(bytes, "writebytes", 0, 64 * 1024 * 1024);
        for (let i = 0; i < roots.length; i++) {
            const current = await directory(fs, roots[i]);
            if (current.dev !== owners[i].dev || current.ino !== owners[i].ino) throw failure("DESTINATION", "Storage root identity changed");
        }
        if (outputowner) {
            const current = await directory(fs, destination, boundary);
            if (current.dev !== outputowner.dev || current.ino !== outputowner.ino) throw failure("DESTINATION", "Output directory identity changed");
        }
        const usedbytes = await measure(fs, roots, owners);
        const pending = bytes + FileOverhead + (final ? 0 : FinalAllowance);
        if (usedbytes + pending > config.capbytes) throw failure("BUDGET", "Aggregate retained rehearsal allocation would exceed cap");
        let minimumfree = Number.MAX_SAFE_INTEGER;
        for (const root of roots) {
            const info = await capacity(root);
            const blocksize = BigInt(info.bsize);
            const available = BigInt(info.bavail);
            if (blocksize <= 0n || available < 0n) throw failure("CAPACITY", "Invalid filesystem capacity");
            const free = available * blocksize;
            const needed = BigInt(config.reservebytes) + BigInt(pending);
            if (free < needed) throw failure("DISK_RESERVE", "Filesystem would fall below the free-space reserve");
            minimumfree = Math.min(minimumfree, Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free));
        }
        return { usedbytes, minimumfree };
    }
    await check();
    await fs.mkdir(destination, { mode: 0o700 });
    outputowner = await directory(fs, destination, boundary);

    async function persist(name, data, final) {
        if (!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(name) || !Buffer.isBuffer(data)) throw failure("CONFIG", "Expected a bounded buffer and a simple output filename");
        let handle;
        try {
            const budget = await check(data.length, final);
            handle = await fs.open(Path.join(destination, name), Flags.O_WRONLY | Flags.O_CREAT | Flags.O_EXCL | (Flags.O_NOFOLLOW ?? 0), 0o400);
            await handle.writeFile(data);
            await handle.sync();
            return budget;
        } finally {
            if (handle) await handle.close();
        }
    }
    async function write(name, data, final = false) {
        if (busy || sealed) throw failure("BACKPRESSURE", "Storage accepts one write at a time and no writes after sealing");
        if (["status.json", "status.pending.json"].includes(name)) throw failure("CONFIG", "Status names are reserved for staged finalization");
        busy = true;
        try {
            return await persist(name, data, final);
        } finally {
            busy = false;
        }
    }
    // Only status.json is authoritative for runtime completion. status.pending.json
    // is retained nonauthoritative evidence, even if its JSON says COMPLETE.
    // The last operation publishes exclusively; there is deliberately no fallible
    // postpublication sync. The pathname's crash durability remains UNCONFIRMED.
    async function finalize(data) {
        if (busy || sealed) throw failure("BACKPRESSURE", "Storage cannot finalize while busy or sealed");
        busy = true;
        let publicationattempted = false;
        try {
            await persist("status.pending.json", data, true);
            await check(data.length, true);
            let handle;
            try {
                handle = await fs.open(destination, Flags.O_RDONLY | (Flags.O_DIRECTORY ?? 0) | (Flags.O_NOFOLLOW ?? 0));
                await handle.sync();
            } finally {
                if (handle) await handle.close();
            }
            publicationattempted = true;
            await fs.link(Path.join(destination, "status.pending.json"), Path.join(destination, "status.json"));
        } catch (error) {
            error.publication = publicationattempted ? "INDETERMINATE" : "NOT_PUBLISHED";
            throw error;
        } finally {
            busy = false;
            sealed = true;
        }
    }
    return {
        roots: Object.freeze([...roots]), destination, config: Object.freeze(config),
        check, write, finalize,
        seal() { sealed = true; },
    };
}

module.exports = { createStorage, storageConfig, failure, integer, GiB };
