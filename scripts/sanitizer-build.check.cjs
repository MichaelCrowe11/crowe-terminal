// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const Root = path.resolve(__dirname, "..");
const Helper = import("../frontend/app/monaco/sanitizer-build.mjs");

function fixture(t) {
    const root = mkdtempSync(path.join(os.tmpdir(), "hypheus-sanitizer-unit-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    function write(name, value) {
        const file = path.join(root, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, value);
    }
    write("package.json", "{}");
    write("node_modules/dompurify/package.json", JSON.stringify({ version: "3.4.15", main: "dist/purify.cjs.js" }));
    write("node_modules/dompurify/dist/purify.cjs.js", "");
    for (const [name, version, source] of [
        ["monaco-editor", "0.55.1", "esm/vs/base/browser/domSanitize.js"],
        ["@codingame/monaco-vscode-api", "32.0.2", "vscode/src/vs/base/browser/domSanitize.js"],
    ]) {
        write(`node_modules/${name}/package.json`, JSON.stringify({ version, main: "index.js" }));
        write(`node_modules/${name}/index.js`, "");
        write(`node_modules/${name}/${source}`, readFileSync(path.join(Root, "node_modules", name, source)));
    }
    return { root, write };
}

test("installed owner guards and direct pin match reviewed versions", async () => {
    const { verifySanitizerOwners } = await Helper;
    assert.ok(verifySanitizerOwners().vendor.endsWith("/dompurify/dompurify.js"));
    const manifest = require("../package.json");
    assert.equal(manifest.dependencies.dompurify, "3.4.15");
    for (const name of ["monaco-editor", "@codingame/monaco-vscode-api"]) {
        assert.equal(manifest.overrides[name].dompurify, "$dompurify");
    }
});

for (const owner of ["monaco-editor", "@codingame/monaco-vscode-api"]) {
    test(`reject unexpected ${owner} version`, async (t) => {
        const { root, write } = fixture(t);
        write(`node_modules/${owner}/package.json`, JSON.stringify({ version: "99.0.0", main: "index.js" }));
        assert.throws(() => (t.helper).verifySanitizerOwners(root), /Review sanitizer integration/);
    });
}

test.beforeEach(async (t) => { t.helper = await Helper; });

for (const [owner, source] of [
    ["monaco-editor", "esm/vs/base/browser/domSanitize.js"],
    ["@codingame/monaco-vscode-api", "vscode/src/vs/base/browser/domSanitize.js"],
]) {
    test(`reject changed ${owner} import or policy`, (t) => {
        const { root, write } = fixture(t);
        write(`node_modules/${owner}/${source}`, "import purify from 'dompurify';");
        assert.throws(() => t.helper.verifySanitizerOwners(root), /Unexpected sanitizer import\/policy shape/);
    });
}

test("reject old direct DOMPurify", (t) => {
    const { root, write } = fixture(t);
    write("node_modules/dompurify/package.json", JSON.stringify({ version: "3.2.7", main: "dist/purify.cjs.js" }));
    assert.throws(() => t.helper.verifySanitizerOwners(root), /Expected DOMPurify 3.4.15/);
});

test("reject ineffective nested override", (t) => {
    const { root, write } = fixture(t);
    write("node_modules/@codingame/monaco-vscode-api/node_modules/dompurify/package.json", JSON.stringify({ main: "index.js" }));
    write("node_modules/@codingame/monaco-vscode-api/node_modules/dompurify/index.js", "");
    assert.throws(() => t.helper.verifySanitizerOwners(root), /override is not effective/);
});

test("production resolver redirects only the exact resolved vendor, not Codingame or bare imports", async (t) => {
    const helper = t.helper;
    const plugin = helper.monacoSanitizerPlugin();
    const { vendor, adapter } = helper.verifySanitizerOwners();
    const context = { resolve: async (id) => ({ id }) };
    const id = await plugin.resolveId.call(context, vendor);
    assert.ok(id.startsWith("\0"));
    assert.equal(plugin.load(id), `export { MonacoDOMPurify as default } from ${JSON.stringify(adapter)};`);
    assert.equal(await plugin.resolveId.call(context, "dompurify"), undefined);
    assert.equal(await plugin.resolveId.call(context, "/other/dompurify/dompurify.js"), undefined);
    assert.equal(await plugin.resolveId.call(context, vendor + "?unexpected"), undefined);
});

test("production graph rejects surviving vendor including query and Windows paths", (t) => {
    const { vendor } = t.helper.verifySanitizerOwners();
    for (const id of [vendor, vendor + "?raw", vendor.replaceAll("/", "\\")]) {
        assert.throws(() => t.helper.assertNoVendoredSanitizer([id]), /Unpatched Monaco sanitizer/);
    }
    t.helper.assertNoVendoredSanitizer(["/node_modules/dompurify/dist/purify.es.mjs"]);
});

test("optimizer intercepts exact relative vendor and checks actual esbuild input graph", async (t) => {
    const { build } = await import("esbuild");
    const graphs = [];
    const plugin = t.helper.monacoSanitizerPlugin({ onGraph: (kind, ids) => graphs.push({ kind, ids }) });
    const { esbuildOptions } = plugin.config().optimizeDeps;
    const result = await build({
        ...esbuildOptions,
        stdin: {
            contents: "import purify from './dompurify/dompurify.js'; console.log(purify.version);",
            resolveDir: path.join(Root, "node_modules/monaco-editor/esm/vs/base/browser"),
        },
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
    });
    assert.ok(graphs[0].ids.some((id) => id.endsWith("monaco-dompurify.ts")));
    assert.ok(graphs[0].ids.some((id) => id.endsWith("dompurify/dist/purify.es.mjs")));
    assert.match(result.outputFiles[0].text, /3\.4\.15/);
    t.helper.assertNoVendoredSanitizer(graphs[0].ids);
});
