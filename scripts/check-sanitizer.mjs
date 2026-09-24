// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer, preview } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { assertNoVendoredSanitizer, loadVscodeCssAsString, monacoSanitizerPlugin } from "../frontend/app/monaco/sanitizer-build.mjs";

const Root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const Output = process.env.SANITIZER_OUTPUT || await mkdtemp(path.join(os.tmpdir(), "hypheus-sanitizer-browser-"));
await mkdir(Output, { recursive: true });
const Results = [];
const Graphs = [];
const config = {
    configFile: false,
    root: path.join(Root, "frontend/preview/sanitizer"),
    publicDir: false,
    cacheDir: path.join(Output, "cache"),
    plugins: [
        monacoSanitizerPlugin({ onGraph: (kind, ids) => Graphs.push({ kind, ids }) }),
        loadVscodeCssAsString(),
        tsconfigPaths({ projects: [path.join(Root, "tsconfig.json")] }),
    ],
    worker: { format: "es" },
    optimizeDeps: { include: ["monaco-yaml/yaml.worker.js"], force: true },
    build: { outDir: path.join(Output, "dist"), minify: true, target: "chrome140", sourcemap: true },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [Root] } },
    preview: { host: "127.0.0.1", port: 0 },
};
const browser = await chromium.launch({
    channel: process.env.BROWSER_EXECUTABLE ? undefined : "chrome",
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    headless: true,
});

async function exercise(server, mode) {
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const errors = [];
    const blocked = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) return route.continue();
        blocked.push(url.origin + url.pathname);
        return route.abort();
    });
    try {
        await page.goto(origin);
        await page.waitForFunction(() => window.sanitizerRegression?.done, undefined, { timeout: 120000 });
        const state = await page.evaluate(() => window.sanitizerRegression);
        await page.screenshot({ path: path.join(Output, `${mode}.png`), fullPage: true });
        Results.push({ mode, ...state, errors, blocked });
        await writeFile(path.join(Output, "results.json"), JSON.stringify(Results, null, 2));
        console.log(JSON.stringify(Results[Results.length - 1]));
    } finally {
        await page.close();
    }
}

try {
    const dev = await createServer(config);
    try {
        await dev.listen();
        await exercise(dev, "development");
        const metadata = JSON.parse(await readFile(path.join(Output, "cache/deps/_metadata.json"), "utf8"));
        assert.ok(Object.keys(metadata.optimized).some((id) => id.includes("monaco")), "fresh development prebundles missing");
    } finally {
        await dev.close();
    }
    await build(config);
    const prod = await preview(config);
    try {
        await exercise(prod, "production");
    } finally {
        await new Promise((resolve, reject) => prod.httpServer.close((error) => error ? reject(error) : resolve()));
    }
    for (const kind of ["optimizeDeps", "build"]) {
        const graphs = Graphs.filter((graph) => graph.kind === kind);
        assert.ok(graphs.length, `${kind} graph missing`);
        const ids = graphs.flatMap((graph) => graph.ids);
        assertNoVendoredSanitizer(ids);
        assert.ok(ids.some((id) => id.endsWith("monaco-dompurify.ts")), `${kind} adapter missing`);
        assert.ok(ids.some((id) => id.endsWith("dompurify/dist/purify.es.mjs")), `${kind} patched dependency missing`);
    }
} catch (error) {
    Results.push({ mode: "harness", errors: [String(error.stack || error)] });
} finally {
    await browser.close();
    await writeFile(path.join(Output, "results.json"), JSON.stringify(Results, null, 2));
    await writeFile(path.join(Output, "module-graphs.json"), JSON.stringify(Graphs, null, 2));
}
console.log(JSON.stringify({ output: Output, results: Results }, null, 2));
if (Results.length !== 2 || Results.some((result) => result.errors.length || result.blocked?.length || result.results?.some((test) => !test.passed))) process.exitCode = 1;
