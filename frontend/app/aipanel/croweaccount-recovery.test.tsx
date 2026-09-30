// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { atom, PrimitiveAtom, Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as AIUtils from "./ai-utils";
import { WaveUIMessage } from "./aitypes";
import { CroweAccountDraftRecovery } from "./croweaccount";
import { CroweAccountMode, CroweAccountModel, CroweSignInRequired } from "./croweaccount-model";
import { DroppedFile, WaveAIModel } from "./waveai-model";

let model: WaveAIModel;
let chat: Chat<WaveUIMessage>;
let attachment: DroppedFile;
let request: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.restoreAllMocks();
    if (!atoms) {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        initGlobalAtoms({ tabId: "test", windowId: "test" } as GlobalInitOptions);
        log.mockRestore();
    }
    CroweAccountModel.resetInstance();
    CroweAccountModel.getInstance().applyStatus({ state: "connected" });
    model = Reflect.construct(WaveAIModel, ["tab:test", false]);
    model.accountSubmissions = new Map();
    model.unsentAccountDrafts = atom([]);
    model.currentAIMode = atom(CroweAccountMode);
    model.aiModeConfigs = atom({ [CroweAccountMode]: { "display:name": "Account", "ai:apitype": "crowe-gateway" } });
    model.inputAtom = atom("original prompt");
    attachment = {
        id: "file",
        file: new File(["contents"], "draft.txt", { type: "text/plain" }),
        name: "draft.txt",
        type: "text/plain",
        size: 8,
        previewUrl: "blob:test-preview",
    };
    model.droppedFiles = atom([attachment]);
    model.chatId = atom("original-chat");
    model.isLoadingChatAtom = atom(false);
    model.isChatEmptyAtom = atom(false);
    model.errorMessage = atom(null) as PrimitiveAtom<string>;
    model.accountErrorAtom = atom(null) as PrimitiveAtom<"signin" | "legacykey">;
    model.useChatStatus = "ready";
    vi.spyOn(AIUtils, "createDataUrl").mockResolvedValue("data:text/plain;base64,Y29udGVudHM=");
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    request = vi.fn().mockImplementation(async () => new Response(CroweSignInRequired, { status: 401 }));
    vi.stubGlobal("fetch", request);
    chat = new Chat<WaveUIMessage>({
        messages: [{ id: "prior", role: "user", parts: [{ type: "text", text: "prior request" }] }],
        transport: new DefaultChatTransport({
            api: "https://app.invalid/chat",
            fetch: (input, init) => model.fetchChat(input, init),
            prepareSendMessagesRequest: () => ({
                body: { msg: model.getAndClearMessage(), chatid: globalStore.get(model.chatId) },
            }),
        }),
        onError: (error) => model.setError(error.message),
    });
    model.useChatSendMessage = vi.fn(chat.sendMessage);
    model.useChatSetMessages = vi.fn((update) => {
        chat.messages = typeof update === "function" ? update(chat.messages) : update;
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    CroweAccountModel.resetInstance();
});

function recoveryMarkup() {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <CroweAccountDraftRecovery model={model} />
        </Provider>
    );
}

describe("definitive pre-persistence account rejection", () => {
    it("rolls back only the optimistic ID and restores actual attachments once without sending", async () => {
        await model.handleSubmit();
        expect(chat.status).toBe("error");
        expect(chat.messages.map((message) => message.id)).toEqual(["prior"]);
        const draft = globalStore.get(model.unsentAccountDrafts)[0];
        expect(draft.input).toBe("original prompt");
        expect(draft.files[0].file).toBe(attachment.file);
        expect(globalStore.get(model.inputAtom)).toBe("");
        expect(revoke).not.toHaveBeenCalled();
        expect(recoveryMarkup()).toContain("Restore unsent draft");
        expect(model.restoreAccountDraft(draft.messageid)).toBe(true);
        expect(model.restoreAccountDraft(draft.messageid)).toBe(false);
        expect(globalStore.get(model.inputAtom)).toBe("original prompt");
        expect(globalStore.get(model.droppedFiles)).toEqual([attachment]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(model.useChatSendMessage).toHaveBeenCalledTimes(1);
        model.clearFiles();
        expect(revoke).toHaveBeenCalledExactlyOnceWith(attachment.previewUrl);
    });

    it("preserves a newer draft and attachments until the user makes space for recovery", async () => {
        request.mockImplementation(async () => {
            globalStore.set(model.inputAtom, "newer draft");
            globalStore.set(model.droppedFiles, [{ ...attachment, id: "new-file", previewUrl: "blob:new-preview" }]);
            return new Response(CroweSignInRequired, { status: 401 });
        });
        await model.handleSubmit();
        const draft = globalStore.get(model.unsentAccountDrafts)[0];
        expect(model.restoreAccountDraft(draft.messageid)).toBe(false);
        expect(globalStore.get(model.inputAtom)).toBe("newer draft");
        expect(globalStore.get(model.droppedFiles)[0].id).toBe("new-file");
        expect(recoveryMarkup()).toContain("Save or clear your current draft");
        model.discardAccountDraft(draft.messageid);
        expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:test-preview");
        expect(globalStore.get(model.droppedFiles)[0].previewUrl).toBe("blob:new-preview");
    });

    it("does not roll back a switched chat and retains explicit cross-chat restoration", async () => {
        request.mockImplementation(async () => {
            globalStore.set(model.chatId, "another-chat");
            return new Response(CroweSignInRequired, { status: 401 });
        });
        await model.handleSubmit();
        expect(model.useChatSetMessages).not.toHaveBeenCalled();
        expect(recoveryMarkup()).toContain("Restore into this chat");
        const draft = globalStore.get(model.unsentAccountDrafts)[0];
        expect(model.restoreAccountDraft(draft.messageid)).toBe(true);
        expect(model.useChatSetMessages).not.toHaveBeenCalled();
        expect(globalStore.get(model.chatId)).toBe("another-chat");
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("retains multiple rejected requests without overwriting earlier recovery", async () => {
        await model.handleSubmit();
        globalStore.set(model.inputAtom, "second prompt");
        globalStore.set(model.droppedFiles, [{ ...attachment, id: "second", previewUrl: "blob:second-preview" }]);
        await model.handleSubmit();
        const drafts = globalStore.get(model.unsentAccountDrafts);
        expect(drafts.map((draft) => draft.input)).toEqual(["original prompt", "second prompt"]);
        expect(new Set(drafts.map((draft) => draft.messageid)).size).toBe(2);
        expect(chat.messages.map((message) => message.id)).toEqual(["prior"]);
        expect(revoke).not.toHaveBeenCalled();
        model.discardAccountDraft(drafts[0].messageid);
        expect(globalStore.get(model.unsentAccountDrafts)).toEqual([drafts[1]]);
        expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:test-preview");
    });

    it("releases preview ownership after a successful stream without altering the user message", async () => {
        request.mockResolvedValue(
            new Response(
                `data: ${JSON.stringify({ type: "start", messageId: "assistant" })}\n\ndata: ${JSON.stringify({ type: "finish" })}\n\ndata: [DONE]\n\n`,
                { status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } }
            )
        );
        await model.handleSubmit();
        expect(chat.status).toBe("ready");
        expect(chat.messages.filter((message) => message.role === "user")).toHaveLength(2);
        expect(globalStore.get(model.unsentAccountDrafts)).toEqual([]);
        expect(model.accountSubmissions.size).toBe(0);
        expect(revoke).toHaveBeenCalledExactlyOnceWith(attachment.previewUrl);
    });

    it.each(["different401", "network", "streamerror"])(
        "does not roll back %s or claim it was unsent",
        async (kind) => {
            if (kind === "different401")
                request.mockResolvedValue(new Response("Another authorization failure", { status: 401 }));
            if (kind === "network") request.mockRejectedValue(new Error("network failed"));
            if (kind === "streamerror")
                request.mockResolvedValue(
                    new Response(
                        `data: ${JSON.stringify({ type: "error", errorText: CroweSignInRequired })}\n\ndata: [DONE]\n\n`,
                        {
                            status: 200,
                            headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
                        }
                    )
                );
            await model.handleSubmit();
            expect(chat.messages).toHaveLength(2);
            expect(chat.messages[1].parts[0]).toEqual({ type: "text", text: "original prompt" });
            expect(globalStore.get(model.unsentAccountDrafts)).toEqual([]);
            expect(revoke).toHaveBeenCalledExactlyOnceWith(attachment.previewUrl);
            expect(model.useChatSetMessages).not.toHaveBeenCalled();
        }
    );
});
