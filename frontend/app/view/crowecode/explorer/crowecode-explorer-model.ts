// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { createBlock, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WaveEnv } from "@/app/waveenv/waveenv";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { CroweCodeWorkspaceModel } from "../crowecode-workspace-model";
import { CroweCodeExplorerView } from "./crowecode-explorer";

// Cached directory listing for a single folder. We cache to avoid re-fetching
// every time a parent toggles expansion; refresh() drops the cache and re-
// fetches.
export type ExplorerEntry = {
    name: string;
    path: string;
    isDir: boolean;
};

export class CroweCodeExplorerViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    blockAtom: jotai.Atom<Block>;

    viewIcon = jotai.atom<string>("folder-tree");
    viewName = jotai.atom<string>("Files");
    noPadding = jotai.atom<boolean>(true);

    // Block-level meta override (crowecode-explorer:root). When unset, falls
    // back to the workspace model's shared workspaceFolderAtom so this block
    // tracks whatever folder an open crowecode editor block is using.
    rootAtom: jotai.Atom<string | undefined>;
    workspaceModel: CroweCodeWorkspaceModel;

    // Map of dir path -> entries[]. Atom holds the whole map so React updates
    // see new references on each fetch.
    entriesAtom: jotai.PrimitiveAtom<Map<string, ExplorerEntry[]>>;
    // Set of dir paths currently expanded.
    expandedAtom: jotai.PrimitiveAtom<Set<string>>;
    // Dirs currently loading (shows a spinner row).
    loadingAtom: jotai.PrimitiveAtom<Set<string>>;
    errorAtom: jotai.PrimitiveAtom<string | null>;

    constructor({ blockId, nodeModel }: { blockId: string; nodeModel: BlockNodeModel; tabModel: TabModel; waveEnv: WaveEnv }) {
        this.viewType = "crowecode-explorer";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.workspaceModel = CroweCodeWorkspaceModel.getInstance();

        this.rootAtom = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const override = blockData?.meta?.["crowecode-explorer:root"];
            if (typeof override === "string" && override.length > 0) return override;
            return get(this.workspaceModel.workspaceFolderAtom);
        });

        this.entriesAtom = jotai.atom(new Map<string, ExplorerEntry[]>());
        this.expandedAtom = jotai.atom(new Set<string>());
        this.loadingAtom = jotai.atom(new Set<string>());
        this.errorAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;
    }

    get viewComponent(): ViewComponent {
        return CroweCodeExplorerView;
    }

    async openRoot(root: string): Promise<void> {
        await this.loadDir(root);
        // Promote into the shared workspace model when this is the first
        // block to open a folder. Other crowecode blocks will pick it up
        // through workspaceFolderAtom.
        if (!this.workspaceModel.getWorkspaceFolder()) {
            this.workspaceModel.setWorkspaceFolder(root);
        }
        // Also persist on the block meta so the explorer reopens to the
        // same root after a tab reload.
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: { "crowecode-explorer:root": root },
        });
    }

    async loadDir(dirPath: string): Promise<void> {
        const loading = new Set(globalStore.get(this.loadingAtom));
        if (loading.has(dirPath)) return;
        loading.add(dirPath);
        globalStore.set(this.loadingAtom, loading);
        globalStore.set(this.errorAtom, null);
        try {
            const infos = await RpcApi.FileListCommand(TabRpcClient, { path: dirPath });
            const entries: ExplorerEntry[] = (infos ?? [])
                .filter((i) => i?.name && !i.name.startsWith("."))
                .map((i) => ({
                    name: i.name!,
                    path: i.path ?? `${dirPath}/${i.name}`,
                    isDir: !!i.isDir,
                }))
                .sort((a, b) => {
                    // dirs first, then alpha
                    if (a.isDir && !b.isDir) return -1;
                    if (!a.isDir && b.isDir) return 1;
                    return a.name.localeCompare(b.name);
                });
            const map = new Map(globalStore.get(this.entriesAtom));
            map.set(dirPath, entries);
            globalStore.set(this.entriesAtom, map);
        } catch (e: any) {
            globalStore.set(this.errorAtom, `load failed: ${e?.message ?? e}`);
        } finally {
            const next = new Set(globalStore.get(this.loadingAtom));
            next.delete(dirPath);
            globalStore.set(this.loadingAtom, next);
        }
    }

    async toggleDir(dirPath: string): Promise<void> {
        const expanded = new Set(globalStore.get(this.expandedAtom));
        if (expanded.has(dirPath)) {
            expanded.delete(dirPath);
            globalStore.set(this.expandedAtom, expanded);
            return;
        }
        expanded.add(dirPath);
        globalStore.set(this.expandedAtom, expanded);
        const cached = globalStore.get(this.entriesAtom).get(dirPath);
        if (!cached) {
            await this.loadDir(dirPath);
        }
    }

    async openFile(filePath: string): Promise<void> {
        // For Phase 3: each click opens a fresh crowecode editor block.
        // Phase 4 will reroute clicks to the active editor block if one
        // exists, keeping the explorer-to-editor flow tighter.
        const workspace = globalStore.get(this.rootAtom);
        const blockDef: BlockDef = {
            meta: {
                view: "crowecode",
                "crowecode:file": filePath,
                ...(workspace ? { "crowecode:workspace": workspace } : {}),
            },
        };
        await createBlock(blockDef, false, false);
    }

    refresh(): void {
        const root = globalStore.get(this.rootAtom);
        if (!root) return;
        globalStore.set(this.entriesAtom, new Map());
        fireAndForget(() => this.loadDir(root));
    }

    keyDownHandler(): boolean {
        return false;
    }

    giveFocus(): boolean {
        return false;
    }
}
