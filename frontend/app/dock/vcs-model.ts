// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { getFocusedBlockId } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";
import { DockModel } from "./dock-model";

const PollIntervalMs = 10_000;
const HistoryLimit = 30;

export class VcsModel {
    private static instance: VcsModel | null = null;
    // Previews seed atoms directly and have no wavesrv to answer RPCs;
    // fetching there would clobber the seeded state with errors.
    static fetchDisabled = false;

    statusAtom = jotai.atom(null) as jotai.PrimitiveAtom<CommandVcsStatusRtnData>;
    historyAtom = jotai.atom([]) as jotai.PrimitiveAtom<VcsOperation[]>;
    expandedOpAtom = jotai.atom(null) as jotai.PrimitiveAtom<string>;
    opFilesAtom = jotai.atom({}) as jotai.PrimitiveAtom<Record<string, VcsFileChange[]>>;
    busyAtom = jotai.atom(false);
    errorAtom = jotai.atom(null) as jotai.PrimitiveAtom<string>;
    dirtyAtom!: jotai.Atom<boolean>;

    pollTimer: ReturnType<typeof setInterval> = null;
    refreshSeq = 0;

    private constructor() {
        this.dirtyAtom = jotai.atom((get) => {
            const s = get(this.statusAtom);
            return !!s?.installed && !!s?.isrepo && !s.clean;
        });
    }

    static getInstance(): VcsModel {
        if (!VcsModel.instance) {
            VcsModel.instance = new VcsModel();
        }
        return VcsModel.instance;
    }

    // The active block's cwd, falling back to empty, which the server resolves
    // to the home directory. Same meta key the terminal itself trusts.
    targetDir(): string {
        const blockId = getFocusedBlockId();
        if (!blockId) {
            return "";
        }
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        return block?.meta?.["cmd:cwd"] ?? "";
    }

    private panelOpen(): boolean {
        const dock = DockModel.getInstance();
        return globalStore.get(dock.activeToolAtom) === "repo" && !globalStore.get(dock.collapsedAtom);
    }

    async refresh(includeHistory?: boolean) {
        if (VcsModel.fetchDisabled) {
            return;
        }
        // A restore/init-triggered refresh must win over a slower in-flight poll
        // response that resolves after it; only the most recent call may write.
        const seq = ++this.refreshSeq;
        const path = this.targetDir();
        try {
            const status = await RpcApi.VcsStatusCommand(TabRpcClient, { path });
            if (seq !== this.refreshSeq) {
                return;
            }
            globalStore.set(this.statusAtom, status);
            if ((includeHistory ?? this.panelOpen()) && status?.isrepo) {
                const hist = await RpcApi.VcsHistoryCommand(TabRpcClient, { path, limit: HistoryLimit });
                if (seq !== this.refreshSeq) {
                    return;
                }
                globalStore.set(this.historyAtom, hist?.operations ?? []);
            }
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            if (seq !== this.refreshSeq) {
                return;
            }
            globalStore.set(this.errorAtom, String(e));
        }
    }

    // Runs for the life of the app so the rail pip stays honest while the
    // panel is closed; history is only fetched while the panel is open.
    startPolling() {
        if (this.pollTimer != null) {
            return;
        }
        this.refresh();
        this.pollTimer = setInterval(() => this.refresh(), PollIntervalMs);
    }

    async toggleOp(opId: string) {
        if (globalStore.get(this.expandedOpAtom) === opId) {
            globalStore.set(this.expandedOpAtom, null);
            return;
        }
        globalStore.set(this.expandedOpAtom, opId);
        if (globalStore.get(this.opFilesAtom)[opId] != null || VcsModel.fetchDisabled) {
            return;
        }
        try {
            const rtn = await RpcApi.VcsOpFilesCommand(TabRpcClient, { path: this.targetDir(), operation: opId });
            globalStore.set(this.opFilesAtom, { ...globalStore.get(this.opFilesAtom), [opId]: rtn?.files ?? [] });
        } catch (e) {
            globalStore.set(this.errorAtom, String(e));
        }
    }

    // The panel's only mutating action. jj's own message comes back verbatim
    // on failure; paraphrasing loses information exactly when it matters.
    async restoreTo(opId?: string) {
        if (globalStore.get(this.busyAtom)) {
            return;
        }
        globalStore.set(this.busyAtom, true);
        let failure: string = null;
        try {
            await RpcApi.VcsRestoreCommand(TabRpcClient, { path: this.targetDir(), operation: opId ?? "" });
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            failure = String(e);
        } finally {
            globalStore.set(this.busyAtom, false);
            globalStore.set(this.opFilesAtom, {});
            await this.refresh(true);
            // refresh()'s success path clears errorAtom; write the action's own
            // failure after it so jj's message survives instead of being erased
            // (spec: restore failures surface jj's message verbatim).
            if (failure != null) {
                globalStore.set(this.errorAtom, failure);
            }
        }
    }

    async initRepo() {
        if (globalStore.get(this.busyAtom)) {
            return;
        }
        globalStore.set(this.busyAtom, true);
        let failure: string = null;
        try {
            await RpcApi.VcsInitCommand(TabRpcClient, { path: this.targetDir() });
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            failure = String(e);
        } finally {
            globalStore.set(this.busyAtom, false);
            await this.refresh(true);
            // refresh()'s success path clears errorAtom; write the action's own
            // failure after it so jj's message survives instead of being erased.
            if (failure != null) {
                globalStore.set(this.errorAtom, failure);
            }
        }
    }
}
