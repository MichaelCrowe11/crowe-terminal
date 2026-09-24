// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { loadMonaco } from "@/app/monaco/monaco-env";
import { MonacoDOMPurify } from "@/app/monaco/monaco-dompurify";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import * as monaco from "monaco-editor";
import { createWebWorker } from "monaco-editor/esm/vs/common/workers.js";
import { sanitizeHtml, safeSetInnerHtml } from "monaco-editor/esm/vs/base/browser/domSanitize.js";
import { renderMarkdown } from "monaco-editor/esm/vs/base/browser/markdownRenderer.js";
import { sanitizeHtml as codingameSanitize, safeSetInnerHtml as codingameSetHtml } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/domSanitize";
import { getService, IThemeService } from "@codingame/monaco-vscode-api/services";

const Results: { name: string; passed: boolean; detail?: string }[] = [];
const State = { done: false, results: Results, workers: [] as string[] };
(window as any).sanitizerRegression = State;

function check(name: string, condition: unknown) {
    Results.push({ name, passed: Boolean(condition) });
    if (!condition) throw new Error(name);
}

function element(html: unknown) {
    const node = document.createElement("div");
    node.innerHTML = String(html);
    return node;
}

async function waitFor(predicate: () => boolean, name: string) {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function run() {
    check("dedicated Monaco instance", MonacoDOMPurify !== DOMPurify);
    check("patched runtime version", MonacoDOMPurify.version === "3.4.15" && DOMPurify.version === "3.4.15");
    const hostile = '<script>window.__sanitizerExecuted=1</script><img src="x" onerror="window.__sanitizerExecuted=1"><svg><g onload="window.__sanitizerExecuted=1"></g></svg><math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=window.__sanitizerExecuted=1>">';
    let sharedHookCalls = 0;
    DOMPurify.addHook("uponSanitizeElement", () => { sharedHookCalls++; });
    for (const [name, sanitize, setHtml] of [
        ["Monaco", sanitizeHtml, safeSetInnerHtml],
        ["Codingame", codingameSanitize, codingameSetHtml],
    ] as const) {
        const before = sharedHookCalls;
        for (let iteration = 0; iteration < 3; iteration++) {
            const clean = element(sanitize(hostile));
            check(`${name} hostile elements ${iteration}`, !clean.querySelector("script,svg,math,iframe,object"));
            check(`${name} hostile attributes ${iteration}`, [...clean.querySelectorAll("*")].every((node) => [...node.attributes].every((attr) => !attr.name.startsWith("on"))));
            const links = element(sanitize('<a href="https://example.com/safe">safe</a><a href="#safe">fragment</a><a href="javascript:alert(1)">script</a><a href="data:text/html,evil">data</a><a href="command:evil">command</a><a href="./relative">relative</a>'));
            check(`${name} safe links ${iteration}`, links.children[0].getAttribute("href") === "https://example.com/safe" && links.children[1].getAttribute("href") === "#safe");
            check(`${name} unsafe links ${iteration}`, [...links.children].slice(2).every((node) => !node.hasAttribute("href")));
            const relative = element(sanitize('<a href="./relative">relative</a>', { allowRelativeLinkPaths: true }));
            check(`${name} explicit relative policy ${iteration}`, relative.firstElementChild.getAttribute("href") === "./relative");
            const target = document.createElement("div");
            setHtml(target, '<b>kept</b><script>evil()</script>');
            check(`${name} DOM fragment ${iteration}`, target.innerHTML === "<b>kept</b>");
        }
        check(`${name} shared hooks do not enter editor`, sharedHookCalls === before);
        DOMPurify.sanitize("<b>probe</b>");
        check(`${name} shared hooks survive editor cleanup`, sharedHookCalls > before);
    }
    let monacoHookCalls = 0;
    MonacoDOMPurify.addHook("uponSanitizeElement", () => { monacoHookCalls++; });
    codingameSanitize("<b>Codingame isolation</b>");
    check("Codingame does not call Monaco instance", monacoHookCalls === 0);
    MonacoDOMPurify.sanitize("<b>probe</b>");
    check("Codingame does not remove Monaco hooks", monacoHookCalls > 0);
    MonacoDOMPurify.removeAllHooks();

    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
    const diagram = 'flowchart LR\n A["<b>Safe diagram</b>"] --> B[Done]';
    const first = await mermaid.render("sanitizer-before", diagram);
    check("Mermaid renders before editor", first.svg.includes("Safe diagram"));
    const mermaidHookProbe = '<a href="https://example.com" target="_blank">safe</a>';
    const beforeEditors = DOMPurify.sanitize(mermaidHookProbe, { ADD_ATTR: ["target"] });
    sanitizeHtml(hostile);
    codingameSanitize(hostile);
    const afterEditors = DOMPurify.sanitize(mermaidHookProbe, { ADD_ATTR: ["target"] });
    check("Mermaid hook behavior survives both editors", beforeEditors === afterEditors && String(afterEditors).includes("noopener"));
    const second = await mermaid.render("sanitizer-after", diagram);
    document.getElementById("mermaid").innerHTML = second.svg;
    check("Mermaid renders after editors", second.svg.includes("Safe diagram"));

    const markdown = renderMarkdown({ value: '**Safe Markdown** [safe](https://example.com) [bad](javascript:alert(1)) <img src=x onerror="window.__sanitizerExecuted=1">', supportHtml: true });
    document.getElementById("markdown").append(markdown.element);
    check("real Markdown renderer", markdown.element.querySelector("strong")?.textContent === "Safe Markdown");
    check("Markdown unsafe href stripped", !markdown.element.querySelector('[href^="javascript:"], [onerror]'));

    const getWorker = window.MonacoEnvironment.getWorker;
    window.MonacoEnvironment.getWorker = (id, label) => {
        State.workers.push(label);
        return getWorker(id, label);
    };
    await loadMonaco();
    const model = monaco.editor.createModel("const answer: number = 42;\n", "typescript", monaco.Uri.parse("file:///sanitizer.ts"));
    const editor = monaco.editor.create(document.getElementById("editor"), { model, automaticLayout: true });
    monaco.languages.registerHoverProvider("typescript", {
        provideHover: () => ({ contents: [{ value: '**Safe hover** [safe](https://example.com) <img src=x onerror="window.__sanitizerExecuted=1">', supportHtml: true }] }),
    });
    editor.setPosition({ lineNumber: 1, column: 8 });
    editor.focus();
    await editor.getAction("editor.action.showHover").run();
    await waitFor(() => document.querySelector(".monaco-hover")?.textContent.includes("Safe hover"), "real editor hover");
    check("real editor hover", !document.querySelector(".monaco-hover [onerror]"));
    const original = monaco.editor.createModel("const answer: number = 41;\n", "typescript");
    const diff = monaco.editor.createDiffEditor(document.getElementById("diff"), { automaticLayout: true });
    diff.setModel({ original, modified: model });
    await waitFor(() => Boolean(diff.getLineChanges()?.length), "diff calculation");
    check("real diff editor computes changes", diff.getLineChanges().length > 0);
    monaco.editor.setTheme("wave-theme-light");
    check("light editor theme", document.querySelector(".monaco-editor.vs") != null);
    monaco.editor.setTheme("wave-theme-dark");
    check("dark editor theme", document.querySelector(".monaco-editor.vs-dark") != null);
    const themeService = await getService(IThemeService);
    check("Codingame theme service initialized", Boolean(themeService.getColorTheme().label));
    await waitFor(() => document.querySelectorAll(".view-lines .mtk1, .view-lines [class*=mtk]").length > 0, "editor token rendering");
    check("editor tokens rendered", document.querySelectorAll(".view-lines [class*=mtk]").length > 0);

    for (const [label, moduleId, filename, text, method, createData] of [
        ["json", "vs/language/json/jsonWorker", "file:///sanitizer.json", '{"a": }', "doValidation", { languageSettings: { validate: true }, enableSchemaRequest: false }],
        ["typescript", "vs/language/typescript/tsWorker", "file:///worker-sanitizer.ts", "const a: number = 'bad';", "getSemanticDiagnostics", { compilerOptions: {}, extraLibs: {} }],
        ["yaml", "monaco-yaml/yaml.worker", "file:///sanitizer.yaml", "a: [\n", "doValidation", { validate: true, enableSchemaRequest: false, schemas: [], customTags: [] }],
    ] as const) {
        const workerModel = monaco.editor.createModel(text, label, monaco.Uri.parse(filename));
        const worker = createWebWorker({ label, moduleId, createData });
        await worker.withSyncedResources([workerModel.uri]);
        const proxy = await worker.getProxy();
        const diagnostics = await proxy[method](filename);
        check(`${label} real worker diagnostics`, Array.isArray(diagnostics) && diagnostics.length > 0);
        worker.dispose();
        workerModel.dispose();
    }
    check("no hostile execution", !(window as any).__sanitizerExecuted);
}

run().catch((error) => {
    Results.push({ name: "fixture completion", passed: false, detail: String(error.stack || error) });
}).finally(() => { State.done = true; });
