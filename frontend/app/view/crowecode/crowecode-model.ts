// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WOS } from "@/store/global";
import { WaveEnv } from "@/app/waveenv/waveenv";
import { checkKeyPressed } from "@/util/keyutil";
import { base64ToString, fireAndForget, stringToBase64 } from "@/util/util";
import * as jotai from "jotai";
import { CroweCodeView } from "./crowecode";

const PLACEHOLDER_TEXT = `// Crowe Code: editor block

// Set block meta "crowecode:file" to a backing file path; the editor
// will load it on mount and Cmd+S writes it back. With no file set,
// this remains an in-memory scratch buffer.
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
    savedTextAtom: jotai.PrimitiveAtom<string | null>;
    loadErrorAtom: jotai.PrimitiveAtom<string | null>;
    isLoadingAtom: jotai.PrimitiveAtom<boolean>;
    isSavingAtom: jotai.PrimitiveAtom<boolean>;

    fileNameAtom: jotai.Atom<string | undefined>;
    languageAtom: jotai.Atom<string | undefined>;
    scopeAtom: jotai.Atom<string | undefined>;
    dirtyAtom: jotai.Atom<boolean>;
    viewText!: jotai.Atom<HeaderElem[]>;

    constructor({ blockId, nodeModel }: { blockId: string; nodeModel: BlockNodeModel; tabModel: TabModel; waveEnv: WaveEnv }) {
        this.viewType = "crowecode";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);

        this.textAtom = jotai.atom<string>(PLACEHOLDER_TEXT);
        this.savedTextAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;
        this.loadErrorAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;
        this.isLoadingAtom = jotai.atom<boolean>(false);
        this.isSavingAtom = jotai.atom<boolean>(false);

        this.fileNameAtom = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const file = blockData?.meta?.["crowecode:file"];
            return typeof file === "string" && file.length > 0 ? file : undefined;
        });

        this.languageAtom = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const override = blockData?.meta?.["crowecode:language"];
            if (typeof override === "string") return override;
            return languageFromFileName(get(this.fileNameAtom));
        });

        this.scopeAtom = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const s = blockData?.meta?.["crowecode:scope"];
            return typeof s === "string" && s.length > 0 ? s : undefined;
        });

        this.dirtyAtom = jotai.atom((get) => {
            const saved = get(this.savedTextAtom);
            if (saved === null) return false;
            return get(this.textAtom) !== saved;
        });

        this.viewText = jotai.atom((get) => {
            const fileName = get(this.fileNameAtom);
            const lang = get(this.languageAtom);
            const scopeName = get(this.scopeAtom);
            const dirty = get(this.dirtyAtom);
            const isSaving = get(this.isSavingAtom);
            const isLoading = get(this.isLoadingAtom);
            const loadError = get(this.loadErrorAtom);
            const rtn: HeaderElem[] = [];
            if (fileName) {
                rtn.push({ elemtype: "text", text: fileName });
            }
            if (lang) {
                rtn.push({ elemtype: "text", text: lang, className: "crowecode-lang-pill" });
            }
            if (scopeName) {
                rtn.push({ elemtype: "text", text: `scope: ${scopeName}`, className: `crowecode-scope-pill crowecode-scope-${scopeName}` });
            } else {
                rtn.push({ elemtype: "text", text: "ungated", className: "crowecode-scope-pill crowecode-scope-ungated" });
            }
            if (loadError) {
                rtn.push({ elemtype: "text", text: loadError, className: "crowecode-error-pill" });
            }
            if (dirty && fileName) {
                rtn.push({
                    elemtype: "iconbutton",
                    icon: isSaving ? "circle-notch" : "floppy-disk",
                    iconSpin: isSaving,
                    title: "Save (Cmd+S)",
                    click: () => fireAndForget(this.saveToDisk.bind(this)),
                });
                rtn.push({
                    elemtype: "iconbutton",
                    icon: "rotate-left",
                    title: "Revert",
                    click: () => this.revert(),
                });
            }
            if (fileName && !dirty) {
                rtn.push({
                    elemtype: "iconbutton",
                    icon: isLoading ? "circle-notch" : "rotate-right",
                    iconSpin: isLoading,
                    title: "Reload from disk",
                    click: () => fireAndForget(this.loadFromDisk.bind(this)),
                });
            }
            return rtn;
        });
    }

    get viewComponent(): ViewComponent {
        return CroweCodeView;
    }

    async loadFromDisk() {
        const fileName = globalStore.get(this.fileNameAtom);
        if (!fileName) {
            globalStore.set(this.loadErrorAtom, null);
            return;
        }
        if (globalStore.get(this.isLoadingAtom)) return;
        globalStore.set(this.isLoadingAtom, true);
        globalStore.set(this.loadErrorAtom, null);
        try {
            const file = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: fileName } }, null);
            const text = file?.data64 ? base64ToString(file.data64) : "";
            globalStore.set(this.textAtom, text);
            globalStore.set(this.savedTextAtom, text);
        } catch (e: any) {
            globalStore.set(this.loadErrorAtom, `load failed: ${e?.message ?? e}`);
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    async saveToDisk() {
        const fileName = globalStore.get(this.fileNameAtom);
        if (!fileName) return;
        if (globalStore.get(this.isSavingAtom)) return;
        const current = globalStore.get(this.textAtom);
        globalStore.set(this.isSavingAtom, true);
        globalStore.set(this.loadErrorAtom, null);
        try {
            await RpcApi.FileWriteCommand(
                TabRpcClient,
                { info: { path: fileName }, data64: stringToBase64(current) },
                null,
            );
            globalStore.set(this.savedTextAtom, current);
        } catch (e: any) {
            globalStore.set(this.loadErrorAtom, `save failed: ${e?.message ?? e}`);
        } finally {
            globalStore.set(this.isSavingAtom, false);
        }
    }

    revert() {
        const saved = globalStore.get(this.savedTextAtom);
        if (saved === null) return;
        globalStore.set(this.textAtom, saved);
    }

    // bootstrapScope installs a real backend capability grant for this block
    // (via wshrpc CroweCodeBootstrapScopeCommand) and then mirrors the
    // resolved scope name into block meta so the header badge reflects what
    // the registry will actually enforce. Idempotent: if the meta is already
    // set we skip both calls so user/settings overrides take precedence.
    async bootstrapScope() {
        const existing = globalStore.get(this.scopeAtom);
        if (existing) return;
        try {
            const rtn = await RpcApi.CroweCodeBootstrapScopeCommand(TabRpcClient, {
                blockid: this.blockId,
                agentsessionid: "",
                scopename: "sandbox",
                pathglobs: [],
            });
            if (rtn?.granted) {
                await RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", this.blockId),
                    meta: { "crowecode:scope": rtn.scopename || "sandbox" },
                });
            }
        } catch (e) {
            // Bootstrap failures are non-fatal: the block still works,
            // the badge falls back to "ungated" until next attempt.
        }
    }

    keyDownHandler(e: WaveKeyboardEvent): boolean {
        if (checkKeyPressed(e, "Cmd:s")) {
            fireAndForget(this.saveToDisk.bind(this));
            return true;
        }
        return false;
    }

    giveFocus(): boolean {
        return false;
    }
}
