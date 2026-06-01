// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WOS } from "@/store/global";
import { WaveEnv } from "@/app/waveenv/waveenv";
import { checkKeyPressed } from "@/util/keyutil";
import { base64ToString, fireAndForget, stringToBase64 } from "@/util/util";
import * as jotai from "jotai";
import { CroweCodeView } from "./crowecode";
import { CroweCodeWorkspaceModel } from "./crowecode-workspace-model";
import { changedLineRange, decideReconcile } from "./reconcile";

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
    diskChangedAtom: jotai.PrimitiveAtom<boolean>;
    // reloadHighlightAtom carries the 1-indexed lines that changed on the most
    // recent live-reload, so the view can flash them. token monotonically
    // increments so the view re-flashes even when the same lines change twice.
    reloadHighlightAtom: jotai.PrimitiveAtom<{ lines: number[]; token: number; origin: string }>;

    fileNameAtom: jotai.Atom<string | undefined>;
    languageAtom: jotai.Atom<string | undefined>;
    scopeAtom: jotai.Atom<string | undefined>;
    workspaceAtom: jotai.Atom<string | undefined>;
    dirtyAtom: jotai.Atom<boolean>;
    viewText!: jotai.Atom<HeaderElem[]>;
    fileChangeUnsubFn: () => void;
    watchedPath: string = null;
    reloadToken: number = 0;

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
        this.diskChangedAtom = jotai.atom<boolean>(false);
        this.reloadHighlightAtom = jotai.atom<{ lines: number[]; token: number; origin: string }>({ lines: [], token: 0, origin: "" });

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

        this.workspaceAtom = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const w = blockData?.meta?.["crowecode:workspace"];
            return typeof w === "string" && w.length > 0 ? w : undefined;
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
            const diskChanged = get(this.diskChangedAtom);
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
                if (diskChanged) {
                    rtn.push({
                        elemtype: "text",
                        text: "changed on disk",
                        className: "crowecode-error-pill",
                    });
                }
                rtn.push({
                    elemtype: "iconbutton",
                    icon: isSaving ? "circle-notch" : "floppy-disk",
                    iconSpin: isSaving,
                    title: diskChanged ? "Save (overwrites disk changes)" : "Save (Cmd+S)",
                    click: () => fireAndForget(this.saveToDisk.bind(this)),
                });
                rtn.push({
                    elemtype: "iconbutton",
                    icon: isLoading ? "circle-notch" : "rotate-left",
                    iconSpin: isLoading,
                    title: diskChanged ? "Discard local edits and reload from disk" : "Revert",
                    click: () => (diskChanged ? fireAndForget(this.loadFromDisk.bind(this)) : this.revert()),
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

        // Live reload: an agent editor.* tool wrote this file on disk. We
        // subscribe to all file-change events and filter by path in the
        // handler (rather than scoping the subscription) because the block's
        // backing file can change via meta after construction. Event volume is
        // tiny — only agent writes publish — so the broadcast is cheap.
        this.fileChangeUnsubFn = waveEventSubscribeSingle({
            eventType: "crowecode:filechange",
            handler: (event) => this.handleFileChange(event.data),
        });
    }

    // handleFileChange reconciles an on-disk change made by an agent tool. If
    // the buffer has no unsaved edits we reload silently; if it is dirty we
    // refuse to clobber the user's work and raise a conflict flag instead,
    // surfaced as a header warning with an explicit discard-and-reload action.
    private handleFileChange(data: CroweCodeFileChangeData) {
        const fileName = globalStore.get(this.fileNameAtom);
        const action = decideReconcile({
            matchesOpenFile: !!data?.path && !!fileName && fileName === data.path,
            dirty: globalStore.get(this.dirtyAtom),
        });
        if (action === "ignore") return;
        if (action === "guard") {
            globalStore.set(this.diskChangedAtom, true);
            return;
        }
        fireAndForget(() => this.loadFromDisk(data?.origin));
    }

    // syncFileWatch keeps the backend external-edit watch aligned with the file
    // this block currently has open. The path can change via meta, so we release
    // any prior watch before registering the new one; each Watch is balanced by
    // an Unwatch here or in dispose(). Fire-and-forget: a missed watch only costs
    // the out-of-app live reload, never correctness of the in-memory buffer.
    private syncFileWatch(path: string | undefined) {
        const next = path ?? null;
        if (next === this.watchedPath) return;
        const prev = this.watchedPath;
        this.watchedPath = next;
        if (prev) {
            fireAndForget(() => RpcApi.CroweCodeWatchFileCommand(TabRpcClient, { path: prev, unwatch: true }));
        }
        if (next) {
            fireAndForget(() => RpcApi.CroweCodeWatchFileCommand(TabRpcClient, { path: next }));
        }
    }

    get viewComponent(): ViewComponent {
        return CroweCodeView;
    }

    async loadFromDisk(origin?: string) {
        const fileName = globalStore.get(this.fileNameAtom);
        this.syncFileWatch(fileName);
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
            const prevText = globalStore.get(this.textAtom);
            const wasLoaded = globalStore.get(this.savedTextAtom) !== null;
            globalStore.set(this.textAtom, text);
            globalStore.set(this.savedTextAtom, text);
            globalStore.set(this.diskChangedAtom, false);
            // Flash the lines that changed, but only on a true reload (the file
            // was already loaded once) — never on the initial mount, where every
            // line would "change" from the placeholder.
            if (wasLoaded && prevText !== text) {
                const lines = changedLineRange(prevText, text);
                if (lines.length > 0) {
                    this.reloadToken++;
                    globalStore.set(this.reloadHighlightAtom, { lines, token: this.reloadToken, origin: origin ?? "" });
                }
            }
            // Make the file URI discoverable to VS Code services so language
            // servers, search, and diagnostics can operate on it. Fire-and-
            // forget: registration failure doesn't affect the in-memory edit.
            this.registerWithWorkspace(fileName).catch(() => {});
        } catch (e: any) {
            globalStore.set(this.loadErrorAtom, `load failed: ${e?.message ?? e}`);
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    private async registerWithWorkspace(fileName: string): Promise<void> {
        const workspaceModel = CroweCodeWorkspaceModel.getInstance();
        const workspace = globalStore.get(this.workspaceAtom);
        if (workspace && !workspaceModel.getWorkspaceFolder()) {
            workspaceModel.setWorkspaceFolder(workspace);
        }
        await workspaceModel.ensureFileRegistered(fileName);
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
            globalStore.set(this.diskChangedAtom, false);
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
                    meta: { "crowecode:scope": rtn.scopename || "sandbox" } as MetaType,
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

    dispose() {
        this.fileChangeUnsubFn?.();
        this.syncFileWatch(undefined);
    }
}
