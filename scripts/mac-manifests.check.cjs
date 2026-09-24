// Copyright 2026, Crowe Logic, Inc.

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const YAML = require("yaml");
const { verifyManifests } = require("./verify-mac-manifests.cjs");

const Root = path.resolve(__dirname, "..");
const Generator = path.join(__dirname, "gen-latest-mac-yml.sh");
const Verifier = path.join(__dirname, "verify-mac-manifests.cjs");
const Version = "0.15.7";
const ReleaseDate = "2026-09-20T12:34:56.000Z";
const Channels = ["latest-mac.yml", "alpha-mac.yml", "beta-mac.yml"];
const Names = [
    `Hypheus-darwin-arm64-${Version}.zip`,
    `Hypheus-darwin-x64-${Version}.zip`,
    `Hypheus-darwin-arm64-${Version}.dmg`,
    `Hypheus-darwin-x64-${Version}.dmg`,
];

function fixture(t, names = Names) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mac-manifests-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const dir = path.join(temporary, "artifacts with spaces");
    fs.mkdirSync(dir);
    for (const [index, name] of names.entries()) {
        fs.writeFileSync(path.join(dir, name), `fixture-${index}-original-bytes\n`);
    }
    return dir;
}

function runGenerator(args, options = {}) {
    return spawnSync("bash", [Generator, ...args], { cwd: Root, encoding: "utf8", timeout: 15000, ...options });
}

function success(result) {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

function failure(result) {
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, result.stdout);
}

function generate(dir, channel = Channels[0]) {
    success(runGenerator([dir, Version, ReleaseDate, channel]));
}

function generateAll(dir) {
    for (const channel of Channels) {
        generate(dir, channel);
    }
}

function readManifest(dir, channel = Channels[0]) {
    return YAML.parse(fs.readFileSync(path.join(dir, channel), "utf8"));
}

function editManifest(dir, edit, channel = Channels[0]) {
    const value = readManifest(dir, channel);
    edit(value);
    fs.writeFileSync(path.join(dir, channel), YAML.stringify(value));
}

function snapshot(dir) {
    return new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
}

test("legacy two and three argument generation selects exact-version unique files and arm64 ZIP", async (t) => {
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, "Hypheus-darwin-arm64-9.9.9.zip"), "unrelated");
    success(runGenerator([dir, Version]));
    await verifyManifests(dir, Version, false);
    success(runGenerator([dir, Version, ReleaseDate]));
    const manifest = readManifest(dir);
    assert.equal(manifest.version, Version);
    assert.equal(manifest.releaseDate, ReleaseDate);
    assert.deepEqual(manifest.files.map((file) => file.url), Names);
    assert.equal(manifest.path, Names[0]);
    for (const file of manifest.files) {
        const bytes = fs.readFileSync(path.join(dir, file.url));
        assert.equal(file.size, bytes.length);
        assert.equal(file.sha512, createHash("sha512").update(bytes).digest("base64"));
    }
    assert.equal(manifest.sha512, manifest.files[0].sha512);
    await verifyManifests(dir, Version, false);
});

test("all three channel manifests verify strictly with a shared timestamp", async (t) => {
    const dir = fixture(t);
    generateAll(dir);
    assert.equal(await verifyManifests(dir, Version, true), 4);
    for (const channel of Channels) {
        assert.equal(readManifest(dir, channel).releaseDate, ReleaseDate);
        assert.deepEqual(readManifest(dir, channel).files.map((file) => file.url), Names);
    }
    success(spawnSync(process.execPath, [Verifier, dir, Version, "--strict"], { cwd: Root, encoding: "utf8" }));
});

test("safe prerelease and build versions round-trip without YAML coercion", async (t) => {
    const version = "0.15.7-beta.2+build.10";
    const dir = fixture(t, [`Hypheus-darwin-arm64-${version}.zip`]);
    success(runGenerator([dir, version, ReleaseDate]));
    assert.equal(readManifest(dir).version, version);
    await verifyManifests(dir, version, false);
});

test("partial mode accepts arm64-only while strict mode requires all four artifacts", async (t) => {
    const dir = fixture(t, [Names[0]]);
    generateAll(dir);
    assert.equal(await verifyManifests(dir, Version, false), 1);
    await assert.rejects(verifyManifests(dir, Version, true), /ENOENT/);
    fs.writeFileSync(path.join(dir, Names[2]), "new dmg");
    await assert.rejects(verifyManifests(dir, Version, false), /missing artifact entries/);
});

for (const channel of Channels) {
    test(`strict mode rejects missing ${channel}`, async (t) => {
        const dir = fixture(t);
        generateAll(dir);
        fs.unlinkSync(path.join(dir, channel));
        await assert.rejects(verifyManifests(dir, Version, true), /ENOENT/);
    });
}

for (const [label, mutate, message] of [
    ["same-length", (bytes) => Buffer.alloc(bytes.length, 120), /SHA-512 mismatch/],
    ["changed-length", (bytes) => Buffer.concat([bytes, Buffer.from("stapled-ticket")]), /size mismatch/],
]) {
    test(`${label} DMG mutation invalidates manifests while ZIP bytes remain unchanged`, async (t) => {
        const dir = fixture(t);
        generateAll(dir);
        const zips = Names.slice(0, 2).map((name) => fs.readFileSync(path.join(dir, name)));
        const dmg = path.join(dir, Names[2]);
        fs.writeFileSync(dmg, mutate(fs.readFileSync(dmg)));
        for (const [index, name] of Names.slice(0, 2).entries()) {
            assert.deepEqual(fs.readFileSync(path.join(dir, name)), zips[index]);
        }
        await assert.rejects(verifyManifests(dir, Version, true), message);
        generate(dir);
        await verifyManifests(dir, Version, false);
        await assert.rejects(verifyManifests(dir, Version, true), /alpha-mac.yml/);
        generate(dir, "alpha-mac.yml");
        await assert.rejects(verifyManifests(dir, Version, true), /beta-mac.yml/);
        generate(dir, "beta-mac.yml");
        await verifyManifests(dir, Version, true);
    });
}

for (const [label, edit, message] of [
    ["wrong version", (value) => { value.version = "0.15.8"; }, /wrong version/],
    ["wrong primary path", (value) => { value.path = Names[1]; }, /primary path/],
    ["wrong primary hash", (value) => { value.sha512 = "wrong"; }, /primary SHA-512/],
    ["wrong artifact hash", (value) => { value.files[2].sha512 = "A".repeat(86) + "=="; }, /SHA-512 mismatch/],
    ["wrong size", (value) => { value.files[2].size += 1; }, /size mismatch/],
    ["duplicate URL", (value) => { value.files.push({ ...value.files[0] }); }, /duplicate artifact/],
    ["missing entry", (value) => { value.files.pop(); }, /missing artifact entries/],
    ["unexpected version URL", (value) => { value.files[0].url = "Hypheus-darwin-arm64-9.9.9.zip"; }, /artifact URL/],
    ["non-array files", (value) => { value.files = {}; }, /files must be an array/],
    ["null entry", (value) => { value.files[0] = null; }, /invalid file entry/],
    ["release date mismatch", (value) => { value.releaseDate = "2026-09-21T12:34:56.000Z"; }, /release date differs/],
]) {
    test(`verifier rejects ${label}`, async (t) => {
        const dir = fixture(t);
        generateAll(dir);
        editManifest(dir, edit, label === "release date mismatch" ? Channels[1] : Channels[0]);
        await assert.rejects(verifyManifests(dir, Version, true), message);
    });
}

for (const size of [0, -1, 1.5, "25", null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`verifier rejects invalid size ${String(size)}`, async (t) => {
        const dir = fixture(t);
        generate(dir);
        editManifest(dir, (value) => { value.files[0].size = size; });
        await assert.rejects(verifyManifests(dir, Version, false), /invalid size/);
    });
}

for (const url of ["../escape.zip", "/tmp/archive.zip", "https://example.com/file.zip", "file:///tmp/file.zip", "file:archive.zip", "subdir/file.zip", "..\\file.zip", "Hypheus-darwin-arm64-0.15.7.zip?download=1", "%2e%2e%2farchive.zip"]) {
    test(`verifier rejects noncanonical URL ${url}`, async (t) => {
        const dir = fixture(t);
        generate(dir);
        editManifest(dir, (value) => { value.files[0].url = url; });
        await assert.rejects(verifyManifests(dir, Version, false), /artifact URL/);
    });
}

for (const [label, mutate] of [
    ["malformed YAML", () => "files: ["],
    ["duplicate top-level key", (text) => `${text}version: '${Version}'\n`],
    ["duplicate nested key", (text) => text.replace("    size:", "    sha512: duplicate\n    size:")],
    ["multiple documents", (text) => `${text}---\nversion: '${Version}'\n`],
    ["empty document", () => ""],
    ["scalar document", () => "a string\n"],
]) {
    test(`verifier rejects ${label}`, async (t) => {
        const dir = fixture(t);
        generate(dir);
        const filename = path.join(dir, Channels[0]);
        fs.writeFileSync(filename, mutate(fs.readFileSync(filename, "utf8")));
        await assert.rejects(verifyManifests(dir, Version, false), /YAML/);
    });
}

test("missing referenced artifact fails even in partial mode", async (t) => {
    const dir = fixture(t);
    generateAll(dir);
    fs.unlinkSync(path.join(dir, Names[2]));
    await assert.rejects(verifyManifests(dir, Version, false), /artifact URL/);
    await assert.rejects(verifyManifests(dir, Version, true), /ENOENT/);
});

test("generator handles empty artifact sets without creating a manifest", (t) => {
    const dir = fixture(t, []);
    failure(runGenerator([dir, Version]));
    assert.deepEqual(fs.readdirSync(dir), []);
});

test("relative option-like directories are not interpreted as command arguments", async (t) => {
    const dir = fixture(t);
    const renamed = path.join(path.dirname(dir), "-artifacts");
    fs.renameSync(dir, renamed);
    success(runGenerator(["-artifacts", Version, ReleaseDate], { cwd: path.dirname(dir), env: { ...process.env, CDPATH: path.dirname(dir) } }));
    await verifyManifests(renamed, Version, false);
});

test("generator requires arm64 ZIP and leaves prior output untouched", (t) => {
    const dir = fixture(t, [Names[1], Names[2]]);
    fs.writeFileSync(path.join(dir, Channels[0]), "previous manifest");
    const before = snapshot(dir);
    failure(runGenerator([dir, Version]));
    assert.deepEqual(snapshot(dir), before);
});

test("generator rejects unsupported arguments without touching existing output", (t) => {
    const dir = fixture(t);
    generateAll(dir);
    const before = snapshot(dir);
    const invalid = [
        [], [dir], [dir, Version, ReleaseDate, Channels[0], "extra"],
        [dir, "../../escape"], [dir, "0.15.7\nfiles: []"], [dir, "0.15.7'"],
        [dir, Version, "2026-09-20'\nfiles: []"], [dir, Version, ""],
        [dir, Version, "2026-99-20T12:34:56Z"],
        ...["../latest-mac.yml", "/tmp/latest-mac.yml", "other.yml", "", "nested/latest-mac.yml"].map((name) => [dir, Version, ReleaseDate, name]),
    ];
    for (const args of invalid) {
        failure(runGenerator(args));
        assert.deepEqual(snapshot(dir), before);
    }
});

test("verifier CLI rejects missing, extra, unsupported, and unsafe arguments", (t) => {
    const dir = fixture(t);
    generateAll(dir);
    for (const args of [[], [dir], [dir, Version, "--unknown"], [dir, Version, "--strict", "extra"], [dir, "../escape"], ["", Version]]) {
        failure(spawnSync(process.execPath, [Verifier, ...args], { cwd: Root, encoding: "utf8", timeout: 15000 }));
    }
});

for (const target of [Names[0], Names[2], Channels[0]]) {
    for (const kind of ["symlink", "dangling symlink", "directory", "FIFO"]) {
        test(`reject ${kind} at ${target}`, async (t) => {
            const dir = fixture(t);
            generateAll(dir);
            const filename = path.join(dir, target);
            fs.unlinkSync(filename);
            if (kind === "directory") {
                fs.mkdirSync(filename);
            } else if (kind === "FIFO") {
                success(spawnSync("mkfifo", [filename], { encoding: "utf8" }));
            } else {
                fs.symlinkSync(path.join(dir, kind === "symlink" ? Names[1] : "absent"), filename);
            }
            await assert.rejects(verifyManifests(dir, Version, true), /regular file/);
            failure(runGenerator([dir, Version, ReleaseDate]));
        });
    }
}

test("artifact directory cannot itself be a symlink or a regular file", async (t) => {
    const dir = fixture(t);
    generateAll(dir);
    const alias = path.join(path.dirname(dir), "alias");
    fs.symlinkSync(dir, alias);
    for (const value of [alias, `${alias}/`, path.join(dir, Names[0])]) {
        await assert.rejects(verifyManifests(value, Version, true), /directory/);
        failure(runGenerator([value, Version, ReleaseDate]));
    }
});

for (const [label, command, body] of [
    ["digest command failure masked by successful base64", "openssl", 'if [ "$1" = dgst ]; then exit 71; fi\nprintf "%086d==" 0\n'],
    ["base64 command failure", "openssl", 'if [ "$1" = dgst ]; then printf bytes; exit 0; fi\nexit 72\n'],
    ["size command failure", "wc", "exit 73\n"],
    ["invalid size output", "wc", 'printf "invalid\\n"\n'],
    ["rename command failure", "mv", "exit 74\n"],
]) {
    test(`atomic output survives ${label} and only owned temp is removed`, (t) => {
        const dir = fixture(t);
        generateAll(dir);
        fs.writeFileSync(path.join(dir, ".latest-mac.yml.other-owner"), "keep me");
        const before = snapshot(dir);
        const bin = path.join(path.dirname(dir), "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, command), `#!/bin/sh\n${body}`, { mode: 0o755 });
        failure(runGenerator([dir, Version, ReleaseDate], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }));
        assert.deepEqual(snapshot(dir), before);
    });
}
