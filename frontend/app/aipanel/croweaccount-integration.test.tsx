// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { DockModel } from "@/app/dock/dock-model";
import { atoms, initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { atom, PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CroweAccountMode, CroweAccountModel, CroweSignInRequired } from "./croweaccount-model";
import { WaveAIModel } from "./waveai-model";

let model: WaveAIModel;
let account: CroweAccountModel;
const showPanel = vi.fn();

beforeEach(() => {
    vi.restoreAllMocks();
    if (!atoms) {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        initGlobalAtoms({ tabId: "test", windowId: "test" } as GlobalInitOptions);
        log.mockRestore();
    }
    showPanel.mockReset();
    CroweAccountModel.resetInstance();
    account = CroweAccountModel.getInstance();
    model = Reflect.construct(WaveAIModel, ["tab:test", false]);
    model.inBuilder = false;
    model.orefContext = "tab:test";
    model.currentAIMode = atom(CroweAccountMode);
    model.aiModeConfigs = atom({
        [CroweAccountMode]: { "display:name": "Crowe account", "ai:apitype": "crowe-gateway" },
        local: { "display:name": "Local", "ai:apitype": "openai-chat" },
        "waveai@crowelm-auto": { "display:name": "Legacy", "ai:apitype": "openai-chat" },
    });
    model.inputAtom = atom("Keep my unsent prompt");
    model.droppedFiles = atom([]);
    model.accountSubmissions = new Map();
    model.unsentAccountDrafts = atom([]);
    model.chatId = atom("existing-chat");
    model.isLoadingChatAtom = atom(false);
    model.isChatEmptyAtom = atom(false);
    model.errorMessage = atom(null) as PrimitiveAtom<string>;
    model.accountErrorAtom = atom(null) as PrimitiveAtom<"signin" | "legacykey">;
    model.useChatStatus = "ready";
    model.useChatSetMessages = vi.fn();
    model.useChatSendMessage = vi.fn();
    vi.spyOn(WorkspaceLayoutModel, "getInstance").mockReturnValue({ setAIPanelVisible: showPanel } as any);
    vi.spyOn(RpcApi, "SetRTInfoCommand").mockResolvedValue(undefined);
    vi.spyOn(RpcApi, "SetConfigCommand").mockResolvedValue(undefined);
});

afterEach(() => {
    CroweAccountModel.resetInstance();
    globalStore.set(atoms.fullConfigAtom, null);
    globalStore.set(atoms.waveaiModeConfigAtom, null);
});

describe("account setup integration", () => {
    it("opens setup without replacing a block, starting a new chat, or changing a local engine", () => {
        globalStore.set(model.currentAIMode, "local");
        model.openCroweAccount();
        expect(showPanel).toHaveBeenCalledWith(true);
        expect(globalStore.get(account.setupVisibleAtom)).toBe(true);
        expect(globalStore.get(model.currentAIMode)).toBe("local");
        expect(globalStore.get(model.inputAtom)).toBe("Keep my unsent prompt");
        expect(globalStore.get(model.chatId)).toBe("existing-chat");
        expect(model.useChatSetMessages).not.toHaveBeenCalled();
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(RpcApi.SetRTInfoCommand).not.toHaveBeenCalled();
        expect(RpcApi.SetConfigCommand).not.toHaveBeenCalled();
    });

    it("reveals account recovery while a compact dock tool is open", () => {
        const dock = DockModel.getInstance();
        dock.toggle("model");
        model.openCroweAccount();
        expect(globalStore.get(dock.collapsedAtom)).toBe(true);
        expect(globalStore.get(account.setupVisibleAtom)).toBe(true);
        model.openEngineSelector();
        model.openEngineSelector();
        expect(globalStore.get(dock.activeToolAtom)).toBe("model");
        expect(globalStore.get(dock.collapsedAtom)).toBe(false);
        expect(globalStore.get(model.currentAIMode)).toBe(CroweAccountMode);
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
    });

    it("switches legacy key mode to account mode only on request and preserves chat and draft", () => {
        globalStore.set(model.currentAIMode, "waveai@crowelm-auto");
        model.setError("Crowe Logic model authentication is not configured. Add a CROWE_MODELS_KEY secret.");
        expect(globalStore.get(model.accountErrorAtom)).toBe("legacykey");
        expect(globalStore.get(model.errorMessage)).not.toContain("CROWE_MODELS_KEY");
        model.useCroweAccount();
        expect(globalStore.get(model.currentAIMode)).toBe(CroweAccountMode);
        expect(globalStore.get(model.inputAtom)).toBe("Keep my unsent prompt");
        expect(globalStore.get(model.chatId)).toBe("existing-chat");
        expect(model.useChatSetMessages).not.toHaveBeenCalled();
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(RpcApi.SetRTInfoCommand).toHaveBeenCalledWith(TabRpcClient, {
            oref: "tab:test",
            data: { "waveai:mode": CroweAccountMode },
        });
    });

    it("saves only the requested default, reports pending/saved, and does not send", async () => {
        globalStore.set(model.currentAIMode, "local");
        let resolveSave: () => void;
        vi.mocked(RpcApi.SetConfigCommand).mockReturnValue(
            new Promise((resolve) => {
                resolveSave = resolve;
            })
        );
        const configs = globalStore.get(model.aiModeConfigs);
        const saving = model.useCroweAccountByDefault();
        expect(globalStore.get(model.croweDefaultSaveStatus)).toBe("saving");
        expect(globalStore.get(model.currentAIMode)).toBe("local");
        await model.useCroweAccountByDefault();
        expect(RpcApi.SetConfigCommand).toHaveBeenCalledExactlyOnceWith(TabRpcClient, {
            "waveai:defaultmode": CroweAccountMode,
        });
        resolveSave();
        await saving;
        expect(globalStore.get(model.croweDefaultSaveStatus)).toBe("saved");
        expect(globalStore.get(model.currentAIMode)).toBe("local");
        expect(RpcApi.SetRTInfoCommand).not.toHaveBeenCalled();
        expect(globalStore.get(account.setupVisibleAtom)).toBe(false);
        expect(globalStore.get(model.aiModeConfigs)).toBe(configs);
        expect(globalStore.get(model.inputAtom)).toBe("Keep my unsent prompt");
        expect(globalStore.get(model.chatId)).toBe("existing-chat");
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
    });

    it("preserves an explicit tab engine change made while the default save is pending", async () => {
        globalStore.set(model.currentAIMode, "local");
        let resolveSave: () => void;
        vi.mocked(RpcApi.SetConfigCommand).mockReturnValue(
            new Promise((resolve) => {
                resolveSave = resolve;
            })
        );
        const saving = model.useCroweAccountByDefault();
        model.setAIMode("waveai@crowelm-auto");
        resolveSave();
        await saving;
        expect(globalStore.get(model.currentAIMode)).toBe("waveai@crowelm-auto");
        expect(RpcApi.SetRTInfoCommand).toHaveBeenCalledExactlyOnceWith(TabRpcClient, {
            oref: "tab:test",
            data: { "waveai:mode": "waveai@crowelm-auto" },
        });
        expect(globalStore.get(model.croweDefaultSaveStatus)).toBe("saved");
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
    });

    it("reports a save failure without changing the selected engine, then permits retry", async () => {
        globalStore.set(model.currentAIMode, "waveai@crowelm-auto");
        vi.mocked(RpcApi.SetConfigCommand).mockRejectedValueOnce(new Error("synthetic internal error"));
        await model.useCroweAccountByDefault();
        expect(globalStore.get(model.croweDefaultSaveStatus)).toBe("error");
        expect(globalStore.get(model.croweDefaultSaveError)).toContain("Could not confirm");
        expect(globalStore.get(model.croweDefaultSaveError)).not.toContain("synthetic internal error");
        expect(globalStore.get(model.currentAIMode)).toBe("waveai@crowelm-auto");
        expect(RpcApi.SetRTInfoCommand).not.toHaveBeenCalled();
        await model.useCroweAccountByDefault();
        expect(globalStore.get(model.croweDefaultSaveStatus)).toBe("saved");
        expect(globalStore.get(model.croweDefaultSaveError)).toBe("");
    });

    it.each(["signedout", "starting", "pending", "expired", "error"])(
        "preserves unsent draft and attachments when account mode is %s",
        async (state) => {
            account.applyStatus({ state, usercode: "ABCD-EFGH" });
            const attachment = { id: "attachment", name: "draft.txt" } as any;
            globalStore.set(model.droppedFiles, [attachment]);
            await model.handleSubmit();
            expect(globalStore.get(model.inputAtom)).toBe("Keep my unsent prompt");
            expect(globalStore.get(model.droppedFiles)).toEqual([attachment]);
            expect(globalStore.get(model.chatId)).toBe("existing-chat");
            expect(globalStore.get(model.errorMessage)).toBe(CroweSignInRequired);
            expect(model.useChatSendMessage).not.toHaveBeenCalled();
        }
    );

    it.each(["local", "waveai@crowelm-auto"])("does not gate %s on account status", async (mode) => {
        globalStore.set(model.currentAIMode, mode);
        await model.handleSubmit();
        expect(model.useChatSendMessage).toHaveBeenCalledTimes(1);
        expect(globalStore.get(account.setupVisibleAtom)).toBe(false);
        expect(globalStore.get(model.accountErrorAtom)).toBeNull();
    });

    it("retains the draft while disconnect is in progress", async () => {
        account.applyStatus({ state: "connected" });
        globalStore.set(account.operationAtom, "disconnect");
        await model.handleSubmit();
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(globalStore.get(model.inputAtom)).toBe("Keep my unsent prompt");
    });

    it("does not send automatically when connected and sends only after explicit submit", async () => {
        model.openCroweAccount();
        account.applyStatus({ state: "connected" });
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(globalStore.get(model.inputAtom)).toBe("Keep my unsent prompt");
        await model.handleSubmit();
        expect(model.useChatSendMessage).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.chatId)).toBe("existing-chat");
    });

    it.each(["local", "waveai@crowelm-auto", "custom", "waveai@balanced"])(
        "keeps saved %s defaults across construction and initial chat loading until explicitly changed",
        async (mode) => {
            const configs = {
                ...globalStore.get(model.aiModeConfigs),
                "waveai@balanced": { "display:name": "User configured engine", "ai:apitype": "openai-chat" },
                custom: {
                    "display:name": "Custom endpoint",
                    "ai:apitype": "openai-chat",
                    "ai:baseurl": "http://localhost:11434",
                },
            };
            const savedSettings = { "waveai:defaultmode": mode, "term:fontsize": 15 };
            globalStore.set(atoms.waveaiModeConfigAtom, configs);
            globalStore.set(atoms.fullConfigAtom, { settings: savedSettings } as FullConfigType);
            vi.spyOn(RpcApi, "GetRTInfoCommand").mockResolvedValue({ "waveai:chatid": "restored" });
            vi.spyOn(RpcApi, "GetWaveAIChatCommand").mockResolvedValue({ messages: [] } as any);
            const fresh: WaveAIModel = Reflect.construct(WaveAIModel, ["tab:fresh", false]);
            expect(globalStore.get(fresh.defaultModeAtom)).toBe(mode);
            expect(globalStore.get(fresh.currentAIMode)).toBe(mode);
            await fresh.loadInitialChat();
            expect(globalStore.get(fresh.currentAIMode)).toBe(mode);
            fresh.useCroweAccount();
            expect(RpcApi.SetConfigCommand).not.toHaveBeenCalled();
            const restarted: WaveAIModel = Reflect.construct(WaveAIModel, ["tab:restart", false]);
            expect(globalStore.get(restarted.currentAIMode)).toBe(mode);
            vi.mocked(RpcApi.SetConfigCommand).mockImplementation(async (_client, settings) => {
                globalStore.set(atoms.fullConfigAtom, {
                    settings: { ...savedSettings, ...settings },
                } as FullConfigType);
            });
            await fresh.useCroweAccountByDefault();
            const afterSave: WaveAIModel = Reflect.construct(WaveAIModel, ["tab:after-save", false]);
            expect(globalStore.get(afterSave.currentAIMode)).toBe(CroweAccountMode);
            vi.mocked(RpcApi.GetRTInfoCommand).mockResolvedValue({ "waveai:chatid": "existing", "waveai:mode": mode });
            await afterSave.loadInitialChat();
            expect(globalStore.get(afterSave.currentAIMode)).toBe(mode);
            expect(globalStore.get(atoms.waveaiModeConfigAtom)).toBe(configs);
            expect(globalStore.get(atoms.settingsAtom)["term:fontsize"]).toBe(15);
            expect(globalStore.get(model.inputAtom)).toBe("Keep my unsent prompt");
        }
    );

    it("maps sign-in errors to safe copy while preserving unrelated errors and reset behavior", () => {
        model.setError("wrapped ErrSignInRequired fictional-access-secret");
        expect(globalStore.get(model.errorMessage)).toBe(CroweSignInRequired);
        expect(globalStore.get(model.accountErrorAtom)).toBe("signin");
        model.setError(`RPC: ${CroweSignInRequired}`);
        expect(globalStore.get(model.errorMessage)).toBe(CroweSignInRequired);
        model.setError("File could not be opened");
        expect(globalStore.get(model.accountErrorAtom)).toBeNull();
        expect(globalStore.get(model.errorMessage)).toBe("File could not be opened");
        model.clearError();
        expect(globalStore.get(model.errorMessage)).toBeNull();
    });
});
