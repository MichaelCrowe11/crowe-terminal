// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Fakes = vi.hoisted(() => ({
    getEnv: vi.fn(),
    status: vi.fn(),
    history: vi.fn(),
    files: vi.fn(),
    restore: vi.fn(),
    init: vi.fn(),
}));
vi.mock("@/app/store/global", () => ({ getFocusedBlockId: () => null }));
vi.mock("@/app/store/wos", () => ({}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        VcsStatusCommand: Fakes.status,
        VcsHistoryCommand: Fakes.history,
        VcsOpFilesCommand: Fakes.files,
        VcsRestoreCommand: Fakes.restore,
        VcsInitCommand: Fakes.init,
    },
}));
vi.mock("./dock-model", async () => {
    const { atom } = await import("jotai");
    const dock = { activeToolAtom: atom("repo"), collapsedAtom: atom(false) };
    return { DockModel: { getInstance: () => dock } };
});

const Rpcs = [Fakes.status, Fakes.history, Fakes.files, Fakes.restore, Fakes.init];

describe("VCS offline rehearsal startup", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        vi.useFakeTimers();
        vi.stubGlobal("window", { api: { getEnv: Fakes.getEnv } });
        Fakes.status.mockResolvedValue({ installed: true, isrepo: false, clean: true, dir: "/synthetic" });
        Fakes.history.mockResolvedValue({ operations: [] });
        Fakes.files.mockResolvedValue({ files: [] });
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("does not schedule, refresh, issue RPCs, or mutate repository state", async () => {
        Fakes.getEnv.mockReturnValue("1");
        const { VcsModel } = await import("./vcs-model");
        const { globalStore } = await import("@/app/store/jotaiStore");
        const model = VcsModel.getInstance();
        const refresh = vi.spyOn(model, "refresh");
        const timer = vi.spyOn(globalThis, "setInterval");
        globalStore.set(model.expandedOpAtom, "existing");
        globalStore.set(model.opFilesAtom, { existing: [] });
        const files = globalStore.get(model.opFilesAtom);

        model.startPolling();
        model.startPolling();
        expect(refresh).not.toHaveBeenCalled();
        expect(timer).not.toHaveBeenCalled();
        expect(model.pollTimer).toBeNull();
        await model.refresh(true);
        await model.refresh(false);
        for (const action of [() => model.initRepo(), () => model.restoreTo("old"), () => model.toggleOp("existing"), () => model.toggleOp("other")]) {
            globalStore.set(model.errorAtom, null);
            await action();
            expect(globalStore.get(model.errorAtom)).toBe("Version control is disabled during offline rehearsal.");
        }
        await vi.advanceTimersByTimeAsync(30_000);
        for (const rpc of Rpcs) expect(rpc).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(model.refreshSeq).toBe(0);
        expect(globalStore.get(model.busyAtom)).toBe(false);
        expect(globalStore.get(model.statusAtom)).toBeNull();
        expect(globalStore.get(model.historyAtom)).toEqual([]);
        expect(globalStore.get(model.expandedOpAtom)).toBe("existing");
        expect(globalStore.get(model.opFilesAtom)).toBe(files);
        expect(Fakes.getEnv).toHaveBeenCalledWith("CROWE_REHEARSAL_OFFLINE");
    });

    it.each([undefined, null, "", "0", "true", "01", " 1"])("retains polling and actions for %s", async (flag) => {
        Fakes.getEnv.mockReturnValue(flag);
        const { VcsModel } = await import("./vcs-model");
        const model = VcsModel.getInstance();
        model.startPolling();
        model.startPolling();
        expect(Fakes.status).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(Fakes.status).toHaveBeenCalledTimes(2);
        await model.initRepo();
        await model.restoreTo("old");
        await model.toggleOp("old");
        expect(Fakes.init).toHaveBeenCalledTimes(1);
        expect(Fakes.restore).toHaveBeenCalledTimes(1);
        expect(Fakes.files).toHaveBeenCalledTimes(1);
        Fakes.status.mockResolvedValueOnce({ installed: true, isrepo: true });
        await model.refresh(true);
        expect(Fakes.history).toHaveBeenCalledTimes(1);
    });
});
