#!/usr/bin/env node
// Copyright 2026, Crowe Logic, Inc.

const { constants } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const YAML = require("yaml");

const ManifestNames = ["latest-mac.yml", "alpha-mac.yml", "beta-mac.yml"];
const VersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DatePattern = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/;
const HashPattern = /^[A-Za-z0-9+/]{86}==$/;

function requireValue(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function openRegular(filename) {
    const before = await fs.lstat(filename);
    requireValue(before.isFile(), `not a regular file (symlinks are forbidden): ${filename}`);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = await handle.stat();
        requireValue(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino, `file changed while opening: ${filename}`);
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}

async function fingerprint(filename) {
    const handle = await openRegular(filename);
    try {
        const before = await handle.stat();
        requireValue(Number.isSafeInteger(before.size) && before.size > 0, `invalid artifact size: ${filename}`);
        const hash = createHash("sha512");
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            size += chunk.length;
            hash.update(chunk);
        }
        const after = await handle.stat();
        const current = await fs.lstat(filename);
        requireValue(
            size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs &&
                after.ctimeMs === before.ctimeMs && current.isFile() && current.dev === before.dev && current.ino === before.ino,
            `artifact changed during verification: ${filename}`
        );
        return { size, sha512: hash.digest("base64") };
    } finally {
        await handle.close();
    }
}

async function readManifest(filename) {
    const handle = await openRegular(filename);
    let text;
    try {
        requireValue((await handle.stat()).size <= 1024 * 1024, `manifest is too large: ${filename}`);
        text = await handle.readFile("utf8");
    } finally {
        await handle.close();
    }
    const documents = YAML.parseAllDocuments(text, { uniqueKeys: true, strict: true });
    requireValue(documents.length === 1, `expected one YAML document: ${filename}`);
    const document = documents[0];
    requireValue(document.errors.length === 0 && document.warnings.length === 0, `invalid YAML: ${filename}: ${[...document.errors, ...document.warnings].map((error) => error.message).join("; ")}`);
    const manifest = document.toJS({ maxAliasCount: 0 });
    requireValue(manifest != null && typeof manifest === "object" && !Array.isArray(manifest), `expected YAML mapping: ${filename}`);
    return manifest;
}

async function verifyManifests(directory, version, strict) {
    requireValue(VersionPattern.test(version), "invalid version");
    const dir = path.resolve(directory);
    requireValue((await fs.lstat(dir)).isDirectory(), "artifact directory must be a nonsymlink directory");
    const names = [
        `Hypheus-darwin-arm64-${version}.zip`,
        `Hypheus-darwin-x64-${version}.zip`,
        `Hypheus-darwin-arm64-${version}.dmg`,
        `Hypheus-darwin-x64-${version}.dmg`,
    ];
    const artifacts = new Map();
    for (const name of names) {
        const filename = path.join(dir, name);
        try {
            await fs.lstat(filename);
        } catch (error) {
            if (error.code === "ENOENT" && !strict && name !== names[0]) {
                continue;
            }
            throw error;
        }
        artifacts.set(name, await fingerprint(filename));
    }
    let releaseDate;
    for (const name of strict ? ManifestNames : [ManifestNames[0]]) {
        const manifest = await readManifest(path.join(dir, name));
        requireValue(manifest.version === version, `${name}: wrong version`);
        requireValue(Array.isArray(manifest.files), `${name}: files must be an array`);
        requireValue(typeof manifest.releaseDate === "string" && DatePattern.test(manifest.releaseDate) && Number.isFinite(Date.parse(manifest.releaseDate)), `${name}: invalid release date`);
        if (releaseDate != null) {
            requireValue(manifest.releaseDate === releaseDate, `${name}: release date differs between channels`);
        }
        releaseDate = manifest.releaseDate;
        const seen = new Set();
        for (const file of manifest.files) {
            requireValue(file != null && typeof file === "object" && !Array.isArray(file), `${name}: invalid file entry`);
            requireValue(typeof file.url === "string" && artifacts.has(file.url), `${name}: unexpected or missing artifact URL: ${file.url}`);
            requireValue(!seen.has(file.url), `${name}: duplicate artifact: ${file.url}`);
            seen.add(file.url);
            const expected = artifacts.get(file.url);
            requireValue(Number.isSafeInteger(file.size) && file.size > 0, `${name}: invalid size: ${file.url}`);
            requireValue(file.size === expected.size, `${name}: size mismatch: ${file.url}`);
            requireValue(typeof file.sha512 === "string" && HashPattern.test(file.sha512) && file.sha512 === expected.sha512, `${name}: SHA-512 mismatch: ${file.url}`);
        }
        requireValue(seen.size === artifacts.size, `${name}: missing artifact entries`);
        requireValue(manifest.path === names[0], `${name}: primary path must be the arm64 ZIP`);
        requireValue(manifest.sha512 === artifacts.get(names[0]).sha512, `${name}: primary SHA-512 mismatch`);
    }
    return artifacts.size;
}

async function main(args) {
    requireValue(args.length >= 2 && args.length <= 3 && (args.length === 2 || args[2] === "--strict") && args[0].length > 0,
        "usage: node scripts/verify-mac-manifests.cjs <dir> <version> [--strict]");
    const count = await verifyManifests(args[0], args[1], args[2] === "--strict");
    console.log(`[verify-mac-manifests] verified ${count} artifacts in ${args[2] === "--strict" ? "all three manifests" : "latest-mac.yml (partial mode)"}`);
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(`[verify-mac-manifests] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { verifyManifests };
