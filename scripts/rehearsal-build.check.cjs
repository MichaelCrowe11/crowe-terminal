// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const Assert = require("node:assert/strict");
const Fs = require("node:fs/promises");
const Path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { prepareBuild, adaptConfig, externalImportsPlugin } = require("./lib/rehearsal-build.cjs");

const Capacity = async () => ({ bsize: 4096n, bavail: 10000000n });

async function fixture() {
    const base = await Fs.mkdtemp("/private/tmp/rehearsal-build-test-");
    const repository = Path.join(base, "repository");
    const estate = Path.join(base, "estate");
    await Fs.mkdir(repository);
    await Fs.mkdir(estate);
    await Fs.writeFile(Path.join(repository, "electron.vite.config.ts"), "// Synthetic config; not product evidence.\n", { flag: "wx" });
    return {
        base,
        options: { repository, roots: [estate], destination: Path.join(estate, "prepared"), estatecomplete: true },
    };
}

function syntheticConfig() {
    const target = (input) => ({ root: ".", plugins: [{ name: "retained-plugin" }], build: { rollupOptions: { input } } });
    return { main: target({ index: "emain/main.ts" }), preload: target("emain/preload.ts"), renderer: target(["index.html"]) };
}

function fakeEsbuild(record = []) {
    return { build: async (options) => {
        record.push(options);
        return { outputFiles: [{ contents: Buffer.from(`export default ${JSON.stringify(syntheticConfig())};`) }] };
    } };
}

test("prepares exclusive config and computed loader without bundling an app", async () => {
    const { options } = await fixture();
    const calls = [];
    const output = await prepareBuild(options, { esbuild: fakeEsbuild(calls), storage: { capacity: Capacity } });
    Assert.equal(output.status, "PREPARED_ONLY");
    Assert.equal(calls.length, 1);
    Assert.equal(calls[0].write, false);
    Assert.deepEqual(calls[0].entryPoints, [Path.join(options.repository, "electron.vite.config.ts")]);
    Assert.equal(calls[0].format, "esm");
    Assert.deepEqual(calls[0].tsconfigRaw, {});
    Assert.equal(output.invocation.options.build, undefined);
    Assert.equal(output.invocation.options.envFile, false);
    Assert.equal(output.invocation.options.root, options.destination);
    Assert.equal(output.invocation.status, "NOT_EXECUTED");
    Assert.equal(output.invocation.method, "build");
    Assert.equal(output.invocation.requiresapproval, true);
    Assert.equal(output.invocation.requiresexternalbudgetcontrol, true);
    Assert.match(output.safety.quota, /PREPARATION_ONLY/);
    Assert.equal(output.safety.actualbuild, "NOT_RUN");
    Assert.equal(output.invocation.cwd, options.repository);
    Assert.deepEqual(Object.keys(output.invocation.env).sort(), ["HOME", "TMPDIR", "XDG_CACHE_HOME"]);
    const loader = await import(pathToFileURL(output.configfile).href);
    const resolved = await loader.default({ command: "build", mode: "development" });
    for (const [target, directory] of Object.entries({ main: "main", preload: "preload", renderer: "frontend" })) {
        const config = resolved[target];
        Assert.equal(config.root, options.repository);
        Assert.equal(config.plugins[0].name, "retained-plugin");
        Assert.equal(config.build.outDir, Path.join(options.destination, "app", "dist", directory));
        Assert.equal(config.build.emptyOutDir, false);
        Assert.equal(config.envFile, false);
        Assert.equal(config.server.watch, null);
        // Installed Vite exposes envDir:false in its resolved config, not the raw owned path.
        await config.plugins.at(-1).configResolved({ ...config, command: "build", envDir: false });
    }
    Assert.deepEqual(resolved.main.build.rollupOptions.input, { index: Path.join(options.repository, "emain/main.ts") });
    Assert.equal(resolved.build, undefined);
    const before = await Fs.readFile(output.preparedfile);
    await Assert.rejects(prepareBuild(options, { esbuild: fakeEsbuild(), storage: { capacity: Capacity } }), /already exists/);
    Assert.deepEqual(await Fs.readFile(output.preparedfile), before);
});

test("bare import resolver uses original importer, external absolute paths and recursion guard", async () => {
    let callback;
    let captured;
    externalImportsPlugin().setup({
        onResolve(_filter, handler) { callback = handler; },
        async resolve(name, options) {
            captured = { name, options };
            Assert.equal(await callback({ path: name, ...options }), undefined);
            return { path: "/synthetic/node_modules/plugin/index.js", errors: [] };
        },
    });
    const result = await callback({ path: "plugin", importer: "/synthetic/config.ts", resolveDir: "/synthetic", kind: "import-statement", namespace: "file" });
    Assert.deepEqual(result, { path: "/synthetic/node_modules/plugin/index.js", external: true });
    Assert.equal(captured.options.importer, "/synthetic/config.ts");
    Assert.equal(captured.options.resolveDir, "/synthetic");
    Assert.deepEqual(await callback({ path: "node:path" }), { path: "node:path", external: true });
    Assert.equal(await callback({ path: "./helper.ts" }), undefined);
});

test("local mjs resolver preserves identity and rejects redirects, symlinks and hard links", async () => {
    const { options } = await fixture();
    const file = Path.join(options.repository, "identity.mjs");
    await Fs.writeFile(file, "export const identity = import.meta.url;", { flag: "wx" });
    let callback;
    let redirect;
    externalImportsPlugin().setup({
        onResolve(_filter, handler) { callback = handler; },
        async resolve(name, args) {
            Assert.equal(await callback({ path: name, ...args }), undefined);
            return { path: redirect ?? Path.resolve(args.resolveDir, name), errors: [], namespace: "file", suffix: "" };
        },
    });
    const request = { path: "./identity.mjs", importer: Path.join(options.repository, "config.ts"), resolveDir: options.repository, kind: "import-statement", namespace: "file" };
    Assert.deepEqual(await callback(request), { path: file, external: true });
    Assert.equal(await callback({ ...request, path: "./helper.ts" }), undefined);
    redirect = Path.join(options.repository, "other.mjs");
    await Assert.rejects(callback(request), /changed module identity/);
    redirect = null;
    await Fs.symlink(file, Path.join(options.repository, "linked.mjs"));
    await Assert.rejects(callback({ ...request, path: "./linked.mjs" }), /Symlink/);
    await Fs.link(file, Path.join(options.repository, "hardlink.mjs"));
    await Assert.rejects(callback(request), /without links/);
});

test("real esbuild retains local ESM import.meta.url in a minimal-environment child", async () => {
    const { options, base } = await fixture();
    const home = Path.join(base, "home");
    const tmp = Path.join(base, "tmp");
    const output = Path.join(base, "output");
    await Fs.mkdir(home);
    await Fs.mkdir(tmp);
    await Fs.mkdir(output);
    const identity = Path.join(options.repository, "identity.mjs");
    const entry = Path.join(options.repository, "entry.ts");
    const helper = Path.join(options.repository, "helper.ts");
    await Fs.writeFile(identity, "export const identity = import.meta.url;\n", { flag: "wx" });
    await Fs.writeFile(helper, "export const value: number = 7;\n", { flag: "wx" });
    await Fs.writeFile(entry, 'export { identity } from "./identity.mjs"; export { value } from "./helper.ts";\n', { flag: "wx" });
    const adapter = require.resolve("./lib/rehearsal-build.cjs");
    const esbuild = require.resolve("esbuild");
    const destination = Path.join(output, "prepared.mjs");
    const script = `
        const assert = require("node:assert/strict");
        const fs = require("node:fs/promises");
        const { pathToFileURL } = require("node:url");
        const esbuild = require(${JSON.stringify(esbuild)});
        const { externalImportsPlugin } = require(${JSON.stringify(adapter)});
        (async () => {
            const result = await esbuild.build({
                entryPoints: [${JSON.stringify(entry)}], absWorkingDir: ${JSON.stringify(options.repository)},
                bundle: true, write: false, platform: "node", format: "esm", target: "node22",
                tsconfigRaw: {}, logLevel: "silent", plugins: [externalImportsPlugin()]
            });
            assert.equal(result.outputFiles.length, 1);
            await fs.writeFile(${JSON.stringify(destination)}, result.outputFiles[0].contents, { flag: "wx" });
            const module = await import(pathToFileURL(${JSON.stringify(destination)}).href);
            assert.equal(module.identity, pathToFileURL(${JSON.stringify(identity)}).href);
            assert.equal(module.value, 7);
            console.log("LOCAL_ESM_IDENTITY_PASS");
        })().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => esbuild.stop());
    `;
    // The parent never starts esbuild; its native service inherits only this explicit child environment.
    const child = spawnSync(process.execPath, ["-e", script], {
        cwd: output,
        env: { HOME: home, TMPDIR: tmp, XDG_CACHE_HOME: Path.join(home, "cache"), PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 20000,
        killSignal: "SIGKILL",
        maxBuffer: 128 * 1024,
    });
    Assert.equal(child.error, undefined);
    Assert.equal(child.status, 0, child.stderr);
    Assert.match(child.stdout, /LOCAL_ESM_IDENTITY_PASS/);
});

test("resolved guards reject escapes, environment loading, watching and output functions", async () => {
    const { options } = await fixture();
    const output = await prepareBuild(options, { esbuild: fakeEsbuild(), storage: { capacity: Capacity } });
    const base = { ...adaptConfig(syntheticConfig(), output.paths).main, envDir: false };
    const guard = base.plugins.at(-1);
    for (const changed of [
        { command: "serve" }, { envFile: true }, { envFile: undefined },
        { envDir: options.repository }, { envDir: output.paths.tmp }, { envDir: undefined }, { envDir: null },
        { cacheDir: Path.join(options.repository, "node_modules/.vite") },
        { root: "/outside" }, { server: { watch: {} } },
        { build: { ...base.build, outDir: Path.join(options.repository, "dist") } },
        { build: { ...base.build, emptyOutDir: true } },
        { build: { ...base.build, watch: {} } },
        { build: { ...base.build, assetsDir: "../escape" } },
        { build: { ...base.build, manifest: "../../escape" } },
        { build: { ...base.build, rollupOptions: { output: { dir: "/outside" } } } },
        { build: { ...base.build, rollupOptions: { output: { entryFileNames: () => "outside" } } } },
    ]) {
        await Assert.rejects(guard.configResolved({ ...base, command: "build", ...changed }));
    }
    await Fs.symlink(options.repository, Path.join(options.destination, "cache/main"));
    await Assert.rejects(guard.configResolved({ ...base, command: "build" }), /Symlink/);
});

test("rejects incomplete estate, oversized cap, low reserve, overlaps and symlink destination ancestors", async () => {
    for (const change of [
        { estatecomplete: false }, { capbytes: 2 * 1024 ** 3 + 1 }, { reservebytes: 20 * 1024 ** 3 - 1 },
    ]) {
        const { options } = await fixture();
        await Assert.rejects(prepareBuild({ ...options, ...change }, { esbuild: fakeEsbuild(), storage: { capacity: Capacity } }));
    }
    const { options, base } = await fixture();
    await Assert.rejects(prepareBuild({ ...options, roots: [options.roots[0], options.roots[0]] }, { esbuild: fakeEsbuild(), storage: { capacity: Capacity } }), /disjoint/);
    const link = Path.join(base, "link");
    await Fs.symlink(options.roots[0], link);
    await Assert.rejects(prepareBuild({ ...options, destination: Path.join(link, "prepared") }, { esbuild: fakeEsbuild(), storage: { capacity: Capacity } }), /Symlink/);
    await Assert.rejects(prepareBuild(options, { esbuild: fakeEsbuild(), storage: { capacity: async () => ({ bsize: 4096n, bavail: 1n }) } }), /reserve/);
});

test("requires explicit esbuild without creating a destination", async () => {
    const { options } = await fixture();
    await Assert.rejects(prepareBuild(options), /Explicit esbuild/);
    await Assert.rejects(Fs.lstat(options.destination), { code: "ENOENT" });
});

test("retains partial destination after preparation failure", async () => {
    const { options } = await fixture();
    await Assert.rejects(prepareBuild(options, { esbuild: { build: async () => { throw new Error("synthetic prebundle failure"); } }, storage: { capacity: Capacity } }), /synthetic/);
    Assert.equal((await Fs.lstat(options.destination)).isDirectory(), true);
    Assert.equal((await Fs.lstat(Path.join(options.destination, "tmp"))).isDirectory(), true);
});
