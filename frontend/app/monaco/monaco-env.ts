// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-javascript-default-extension";
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import "@codingame/monaco-vscode-json-default-extension";

import { initialize as initializeVscodeServices } from "@codingame/monaco-vscode-api";
import getExtensionGalleryServiceOverride from "@codingame/monaco-vscode-extension-gallery-service-override";
import getFilesServiceOverride from "@codingame/monaco-vscode-files-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import * as monaco from "monaco-editor";
import { configureMonacoYaml } from "monaco-yaml";

import { MonacoSchemas } from "@/app/monaco/schemaendpoints";
import TextMateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import ymlWorker from "./yamlworker?worker";

let monacoInitPromise: Promise<void> | null = null;

window.MonacoEnvironment = {
    getWorker(_, label) {
        if (label === "TextEditorWorker") return new editorWorker();
        if (label === "TextMateWorker") return new TextMateWorker();
        if (label === "json") return new jsonWorker();
        if (label === "css" || label === "scss" || label === "less") return new cssWorker();
        if (label === "yaml" || label === "yml") return new ymlWorker();
        if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
        if (label === "typescript" || label === "javascript") return new tsWorker();
        return new editorWorker();
    },
};

export function loadMonaco(): Promise<void> {
    if (monacoInitPromise) return monacoInitPromise;
    monacoInitPromise = (async () => {
        // initialize signature: (overrides, container, configuration, env).
        // The 2-arg pattern in older docs collapsed container; v32 makes it
        // explicit and CSS injection fails (target.getRootNode is not a
        // function) if you pass config in the container slot. We use the
        // default container (document.body) and supply config in slot 3.
        //
        // productConfiguration wires the gallery service to Open VSX, the
        // Eclipse-hosted marketplace used by every non-Microsoft VS Code
        // distribution. That's where users install Prettier, ESLint, Rust
        // Analyzer, Vim, etc. from inside Hypheus.
        await initializeVscodeServices(
            {
                ...getFilesServiceOverride(),
                ...getThemeServiceOverride(),
                ...getTextmateServiceOverride(),
                ...getLanguagesServiceOverride(),
                ...getExtensionGalleryServiceOverride({ webOnly: false }),
            },
            document.body,
            {
                productConfiguration: {
                    extensionsGallery: {
                        serviceUrl: "https://open-vsx.org/vscode/gallery",
                        resourceUrlTemplate:
                            "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
                    },
                },
            } as any,
        );

        monaco.editor.defineTheme("wave-theme-dark", {
            base: "vs-dark",
            inherit: true,
            rules: [],
            colors: {
                "editor.background": "#00000000",
                "editorStickyScroll.background": "#00000055",
                "minimap.background": "#00000077",
                focusBorder: "#00000000",
            },
        });
        monaco.editor.defineTheme("wave-theme-light", {
            base: "vs",
            inherit: true,
            rules: [],
            colors: {
                "editor.background": "#fefefe",
                focusBorder: "#00000000",
            },
        });
        monaco.editor.setTheme("wave-theme-dark");

        // monaco-yaml registers a YAML language client over Monaco's language API.
        // With the VS Code languages-service-override owning the registry, the
        // call may no-op or throw. We still attempt it for Phase 0 since the
        // existing waveconfig YAML editor depends on it; if it fails, swap to
        // redhat.vscode-yaml extension in Phase 2.
        try {
            configureMonacoYaml(monaco, { validate: true, schemas: [] });
        } catch (e) {
            console.warn("[monaco] monaco-yaml deferred until LSP/extension path lands:", e);
        }

        // JSON/TS diagnostic options used `monaco.json` / `monaco.typescript`
        // namespaces that don't exist alongside the languages-service-override.
        // They come back through real LSP wiring in Phase 1+; for now we retain
        // the schemas reference so the import isn't shaken out.
        void MonacoSchemas;
    })();
    return monacoInitPromise;
}
