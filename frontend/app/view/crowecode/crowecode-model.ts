// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { WOS } from "@/store/global";
import { WaveEnv } from "@/app/waveenv/waveenv";
import * as jotai from "jotai";
import { CroweCodeView } from "./crowecode";

const PLACEHOLDER_TEXT = `// Crowe Code: editor block

// Phase 1 (this build): Monaco editor mounts, in-memory buffer.
// Phase 2: LSP bridge for Go, TypeScript, Python diagnostics.
// Phase 3: editor.* tools registered in the agent Tool Registry.
// Phase 4: per-block capability scoping wires into Registry.Call().

// Set block meta "crowecode:file" to backing file path.
// Set block meta "crowecode:language" to override syntax highlighting.
`;

function languageFromFileName(fileName: string | undefined): string | undefined {
    if (!fileName) return undefined;
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
    if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
    if (lower.endsWith(".py")) return "python";
    if (lower.endsWith(".go")) return "go";
    if (lower.endsWith(".rs")) return "rust";
    if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
    if (lower.endsWith(".css")) return "css";
    if (lower.endsWith(".scss") || lower.endsWith(".sass")) return "scss";
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
    if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
    if (lower.endsWith(".sql")) return "sql";
    if (lower.endsWith(".toml")) return "ini";
    return undefined;
}

export class CroweCodeViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    blockAtom: jotai.Atom<Block>;

    viewIcon = jotai.atom<string>("code");
    viewName = jotai.atom<string>("Crowe Code");
    noPadding = jotai.atom<boolean>(true);

    textAtom: jotai.PrimitiveAtom<string>;
    fileNameAtom: jotai.Atom<string | undefined>;
    languageAtom: jotai.Atom<string | undefined>;
    viewText!: jotai.Atom<HeaderElem[]>;

    constructor({ blockId, nodeModel }: { blockId: string; nodeModel: BlockNodeModel; tabModel: TabModel; waveEnv: WaveEnv }) {
        this.viewType = "crowecode";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);

        this.textAtom = jotai.atom<string>(PLACEHOLDER_TEXT);

        this.fileNameAtom = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const file = blockData?.meta?.["crowecode:file"];
            return typeof file === "string" ? file : undefined;
        });

        this.languageAtom = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const override = blockData?.meta?.["crowecode:language"];
            if (typeof override === "string") return override;
            return languageFromFileName(get(this.fileNameAtom));
        });

        this.viewText = jotai.atom((get) => {
            const fileName = get(this.fileNameAtom);
            const lang = get(this.languageAtom);
            const rtn: HeaderElem[] = [];
            if (fileName) {
                rtn.push({ elemtype: "text", text: fileName });
            }
            if (lang) {
                rtn.push({ elemtype: "text", text: lang, className: "crowecode-lang-pill" });
            }
            return rtn;
        });
    }

    get viewComponent(): ViewComponent {
        return CroweCodeView;
    }

    giveFocus(): boolean {
        return false;
    }
}
