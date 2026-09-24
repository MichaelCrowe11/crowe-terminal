// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RepositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const VirtualId = "\0hypheus-monaco-dompurify";
const OptimizerId = "hypheus-monaco-dompurify";
const VendorSuffix = "/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js";
const Owners = [
    {
        name: "monaco-editor",
        version: "0.55.1",
        source: "esm/vs/base/browser/domSanitize.js",
        hash: "fd41b231eb5e191936ed5f84252b4d729a48e722348a82cfae25c45b7308ac7e",
    },
    {
        name: "@codingame/monaco-vscode-api",
        version: "32.0.2",
        source: "vscode/src/vs/base/browser/domSanitize.js",
        hash: "611843d35c1153d2bcdfa9ee6c1ce394495f4ccabd713c316398389130f6c7ee",
    },
];

function normalize(id) {
    return id.replace(/\\/g, "/");
}

export function assertNoVendoredSanitizer(ids) {
    for (const id of ids) {
        if (normalize(id).includes(VendorSuffix)) {
            throw new Error(`Unpatched Monaco sanitizer in module graph: ${id}`);
        }
    }
}

export function verifySanitizerOwners(root = RepositoryRoot) {
    const require = createRequire(path.join(root, "package.json"));
    const purifier = require.resolve("dompurify");
    const purifierRoot = path.dirname(path.dirname(purifier));
    const version = JSON.parse(readFileSync(path.join(purifierRoot, "package.json"), "utf8")).version;
    if (version !== "3.4.15") throw new Error(`Expected DOMPurify 3.4.15, found ${version}`);
    const sources = [];
    for (const owner of Owners) {
        const packageFile = owner.name === "monaco-editor"
            ? require.resolve(`${owner.name}/package.json`)
            : path.join(path.dirname(require.resolve(owner.name)), "package.json");
        const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
        if (manifest.version !== owner.version) {
            throw new Error(`Review sanitizer integration for ${owner.name}@${manifest.version}`);
        }
        const source = path.join(path.dirname(packageFile), owner.source);
        // Pin the consumed interface and policy together; upstream drift requires an explicit review.
        const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
        if (hash !== owner.hash) throw new Error(`Unexpected sanitizer import/policy shape: ${source}`);
        if (realpathSync(createRequire(packageFile).resolve("dompurify")) !== realpathSync(purifier)) {
            throw new Error(`DOMPurify override is not effective for ${owner.name}`);
        }
        sources.push(source);
    }
    return {
        vendor: normalize(path.join(path.dirname(sources[0]), "dompurify/dompurify.js")),
        adapter: normalize(path.join(root, "frontend/app/monaco/monaco-dompurify.ts")),
        sources,
    };
}

/** @returns {import("vite").Plugin} */
export function monacoSanitizerPlugin({ root = RepositoryRoot, onGraph } = {}) {
    const { vendor, adapter, sources } = verifySanitizerOwners(root);
    const reexport = `export { MonacoDOMPurify as default } from ${JSON.stringify(adapter)};`;
    const optimizer = {
        name: "hypheus-monaco-sanitizer",
        setup(build) {
            build.onResolve({ filter: /dompurify/ }, (args) => {
                if (!args.path.startsWith(".") && !path.isAbsolute(args.path)) return;
                const resolved = normalize(path.resolve(args.resolveDir, args.path));
                if (resolved !== vendor) return;
                return { path: OptimizerId, namespace: OptimizerId };
            });
            build.onLoad({ filter: /.*/, namespace: OptimizerId }, () => ({
                contents: reexport,
                loader: "js",
                resolveDir: root,
            }));
            build.onEnd((result) => {
                if (result.errors.length) return;
                if (!result.metafile) throw new Error("Sanitizer optimizer requires a module graph");
                const ids = Object.keys(result.metafile.inputs);
                assertNoVendoredSanitizer(ids);
                onGraph?.("optimizeDeps", ids);
            });
        },
    };
    return {
        name: "hypheus-monaco-sanitizer",
        enforce: "pre",
        config() {
            return { optimizeDeps: { esbuildOptions: { metafile: true, plugins: [optimizer] } } };
        },
        buildStart() {
            verifySanitizerOwners(root);
            for (const source of sources) this.addWatchFile(source);
        },
        async resolveId(source, importer, options) {
            if (!source.includes("dompurify")) return;
            const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
            if (resolved && normalize(resolved.id) === vendor) return VirtualId;
        },
        load(id) {
            if (id === VirtualId) return reexport;
        },
        generateBundle() {
            const ids = [...this.getModuleIds()];
            assertNoVendoredSanitizer(ids);
            if (ids.some((id) => sources.includes(id)) && !ids.includes(VirtualId)) {
                throw new Error("Monaco sanitizer adapter missing from production graph");
            }
            onGraph?.("build", ids);
        },
    };
}

// monaco-vscode-api ships CSS files that Vite would otherwise try to inject as
// <style> tags. The library expects them resolved as inline strings so it can
// own injection through its theme service.
/** @returns {import("vite").Plugin} */
export function loadVscodeCssAsString() {
    return {
        name: "load-vscode-css-as-string",
        enforce: "pre",
        async resolveId(source, importer, options) {
            const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
            if (resolved?.id?.match(/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/)) {
                return { ...resolved, id: resolved.id + "?inline" };
            }
            return undefined;
        },
    };
}
