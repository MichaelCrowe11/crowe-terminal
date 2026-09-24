// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

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
    showPanel.mockReset();
    CroweAccountModel.resetInstance();
    account = CroweAccountModel.getInstance();
    model = Object.create(WaveAIModel.prototype);
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
});

afterEach(() => {
    CroweAccountModel.resetInstance();
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
