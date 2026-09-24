// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    UseChatSendMessageType,
    UseChatSetMessagesType,
    WaveUIMessage,
    WaveUIMessagePart,
} from "@/app/aipanel/aitypes";
import { DockModel } from "@/app/dock/dock-model";
import { FocusManager } from "@/app/store/focusManager";
import { atoms, createBlock, getOrefMetaKeyAtom, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { isBuilderWindow } from "@/app/store/windowtype";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { BuilderFocusManager } from "@/builder/store/builder-focusmanager";
import { getWebServerEndpoint } from "@/util/endpoints";
import { base64ToArrayBuffer } from "@/util/util";
import { ChatStatus } from "ai";
import * as jotai from "jotai";
import type React from "react";
import {
    createDataUrl,
    createImagePreview,
    formatFileSizeError,
    isAcceptableFile,
    normalizeMimeType,
    resizeImage,
    validateFileSizeFromInfo,
} from "./ai-utils";
import type { AIPanelInputRef } from "./aipanelinput";
import {
    CroweAccountMode,
    CroweAccountModel,
    CroweSignInRequired,
    isCroweAccountMode,
    isCroweLegacyKeyError,
    isCroweSignInRequired,
} from "./croweaccount-model";

export type ComposerState = {
    hasContent: boolean;
    loading: boolean;
    pending: boolean;
    needsConnection: boolean;
    localCommand: boolean;
};

export function getComposerAction(status: string, state: ComposerState): "send" | "connect" | "stop" | "disabled" {
    if (state.pending || status === "submitted" || status === "streaming") return "stop";
    if (state.localCommand) return "send";
    if (state.loading || (status !== "ready" && status !== "error")) return "disabled";
    if (state.needsConnection) return "connect";
    return state.hasContent ? "send" : "disabled";
}

export type ToolApprovalDecision = "user-approved" | "user-denied";

export type ToolApprovalRequest = {
    status: "pending" | "submitted" | "error";
    decision: ToolApprovalDecision;
    error?: string;
};

export interface DroppedFile {
    id: string;
    file: File;
    name: string;
    type: string;
    size: number;
    previewUrl?: string;
}

type AccountSubmission = {
    chatid: string;
    messageid: string;
    input: string;
    files: DroppedFile[];
};

const BuilderAIModeConfigs: Record<string, AIModeConfigType> = {
    "waveaibuilder@default": {
        "display:name": "Builder Default",
        "display:order": -2,
        "display:icon": "crowe-mark",
        "display:description": "Fast, capable code generation\n(CroweLM Workspace on Crowe Logic cloud models)",
        "ai:provider": "openai",
        "ai:switchcompat": ["openai"],
    },
    "waveaibuilder@deep": {
        "display:name": "Builder Deep",
        "display:order": -1,
        "display:icon": "lightbulb",
        "display:description": "Maximum reasoning for hard builds\n(CroweLM Deep Work on Crowe Logic cloud models)",
        "ai:provider": "openai",
        "ai:switchcompat": ["openai"],
    },
};

export class WaveAIModel {
    private static instance: WaveAIModel | null = null;
    inputRef: React.RefObject<AIPanelInputRef> | null = null;
    scrollToBottomCallback: (() => void) | null = null;
    useChatSendMessage: UseChatSendMessageType | null = null;
    useChatSetMessages: UseChatSetMessagesType | null = null;
    useChatStatus: ChatStatus = "ready";
    useChatStop: (() => void) | null = null;
    // Used for injecting Wave-specific message data into DefaultChatTransport's prepareSendMessagesRequest
    realMessage: AIMessage | null = null;
    orefContext: ORef;
    inBuilder: boolean = false;
    isAIStreaming = jotai.atom(false);
    toolApprovalRequests: jotai.PrimitiveAtom<Record<string, ToolApprovalRequest>> = jotai.atom({});
    accountSubmissions = new Map<string, AccountSubmission>();
    unsentAccountDrafts: jotai.PrimitiveAtom<AccountSubmission[]> = jotai.atom([]);
    submissionPending = jotai.atom(false);
    submissionVersion = 0;
    preparingSubmission = false;
    composerState!: jotai.Atom<ComposerState>;
    croweDefaultSaveStatus: jotai.PrimitiveAtom<"idle" | "saving" | "saved" | "error"> = jotai.atom("idle");
    croweDefaultSaveError = jotai.atom("");

    widgetAccessAtom!: jotai.Atom<boolean>;
    droppedFiles: jotai.PrimitiveAtom<DroppedFile[]> = jotai.atom([]);
    chatId!: jotai.PrimitiveAtom<string>;
    currentAIMode!: jotai.PrimitiveAtom<string>;
    aiModeConfigs!: jotai.Atom<Record<string, AIModeConfigType>>;
    hasPremiumAtom!: jotai.Atom<boolean>;
    defaultModeAtom!: jotai.Atom<string>;
    errorMessage: jotai.PrimitiveAtom<string> = jotai.atom(null) as jotai.PrimitiveAtom<string>;
    accountErrorAtom: jotai.PrimitiveAtom<"signin" | "legacykey"> = jotai.atom(null) as jotai.PrimitiveAtom<
        "signin" | "legacykey"
    >;
    containerWidth: jotai.PrimitiveAtom<number> = jotai.atom(0);
    codeBlockMaxWidth!: jotai.Atom<number>;
    inputAtom: jotai.PrimitiveAtom<string> = jotai.atom("");
    isLoadingChatAtom: jotai.PrimitiveAtom<boolean> = jotai.atom(false);
    isChatEmptyAtom: jotai.PrimitiveAtom<boolean> = jotai.atom(true);
    isWaveAIFocusedAtom!: jotai.Atom<boolean>;
    panelVisibleAtom!: jotai.Atom<boolean>;
    restoreBackupModalToolCallId: jotai.PrimitiveAtom<string | null> = jotai.atom(null) as jotai.PrimitiveAtom<
        string | null
    >;
    restoreBackupStatus: jotai.PrimitiveAtom<"idle" | "processing" | "success" | "error"> = jotai.atom("idle");
    restoreBackupError: jotai.PrimitiveAtom<string> = jotai.atom(null) as jotai.PrimitiveAtom<string>;

    private constructor(orefContext: ORef, inBuilder: boolean) {
        this.orefContext = orefContext;
        this.inBuilder = inBuilder;
        this.chatId = jotai.atom(null) as jotai.PrimitiveAtom<string>;
        if (inBuilder) {
            this.aiModeConfigs = jotai.atom(BuilderAIModeConfigs) as jotai.Atom<Record<string, AIModeConfigType>>;
        } else {
            this.aiModeConfigs = atoms.waveaiModeConfigAtom;
        }

        this.hasPremiumAtom = jotai.atom((get) => {
            const rateLimitInfo = get(atoms.waveAIRateLimitInfoAtom);
            return !rateLimitInfo || rateLimitInfo.unknown || rateLimitInfo.preq > 0;
        });

        this.widgetAccessAtom = jotai.atom((get) => {
            if (this.inBuilder) {
                return true;
            }
            const widgetAccessMetaAtom = getOrefMetaKeyAtom(this.orefContext, "waveai:widgetcontext");
            const value = get(widgetAccessMetaAtom);
            return value ?? true;
        });

        this.codeBlockMaxWidth = jotai.atom((get) => {
            const width = get(this.containerWidth);
            return width > 0 ? width - 35 : 0;
        });

        this.isWaveAIFocusedAtom = jotai.atom((get) => {
            if (this.inBuilder) {
                return get(BuilderFocusManager.getInstance().focusType) === "waveai";
            }
            return get(FocusManager.getInstance().focusType) === "waveai";
        });

        this.panelVisibleAtom = jotai.atom((get) => {
            if (this.inBuilder) {
                return true;
            }
            return get(WorkspaceLayoutModel.getInstance().panelVisibleAtom);
        });

        this.defaultModeAtom = jotai.atom((get) => {
            // Hypheus: the CroweLM modes ship with their own endpoint and
            // key (models.crowelogic.com), so we don't gate on telemetry like
            // upstream Wave (which needed telemetry consent for wavecloud).
            // Builder modes ship their own waveaibuilder@default.
            if (this.inBuilder) {
                return "waveaibuilder@default";
            }
            const aiModeConfigs = get(this.aiModeConfigs);
            // Hypheus fallback: regardless of "premium" status, land
            // on the cloud-routed CroweLM Workspace mode. Upstream Wave's
            // waveai@balanced / waveai@quick names referenced wavecloud
            // configs that never shipped in this fork — would resolve to
            // "unknown mode" and 400 the chat call.
            // Account-based access now replaces the API-key fallback; disconnecting never changes modes.
            const croweFallback = CroweAccountMode;
            let mode = get(getSettingsKeyAtom("waveai:defaultmode")) ?? croweFallback;
            // If a saved mode points at a phantom waveai@balanced/quick/deep
            // (e.g. left behind from a previous Wave install), force it back
            // to the working default.
            if (
                (mode === "waveai@balanced" || mode === "waveai@quick" || mode === "waveai@deep") &&
                !(aiModeConfigs != null && mode in aiModeConfigs)
            ) {
                mode = croweFallback;
            }
            const modeExists = aiModeConfigs != null && mode in aiModeConfigs;
            if (!modeExists) {
                mode = croweFallback;
            }
            return mode;
        });

        const defaultMode = globalStore.get(this.defaultModeAtom);
        this.currentAIMode = jotai.atom(defaultMode);
        this.composerState = jotai.atom((get) => {
            const mode = get(this.currentAIMode);
            const account = CroweAccountModel.getInstance();
            const input = get(this.inputAtom).trim();
            return {
                hasContent: !!input || get(this.droppedFiles).length > 0,
                localCommand: input === "/clear" || input === "/new",
                loading: get(this.isLoadingChatAtom),
                pending: get(this.submissionPending),
                needsConnection:
                    isCroweAccountMode(mode, get(this.aiModeConfigs)?.[mode]) &&
                    (!get(account.checkedAtom) ||
                        get(account.statusAtom).state !== "connected" ||
                        get(account.operationAtom) != null),
            };
        });
    }

    getPanelVisibleAtom(): jotai.Atom<boolean> {
        return this.panelVisibleAtom;
    }

    static getInstance(): WaveAIModel {
        if (!WaveAIModel.instance) {
            let orefContext: ORef;
            if (isBuilderWindow()) {
                const builderId = globalStore.get(atoms.builderId);
                orefContext = WOS.makeORef("builder", builderId);
            } else {
                const tabId = globalStore.get(atoms.staticTabId);
                orefContext = WOS.makeORef("tab", tabId);
            }
            WaveAIModel.instance = new WaveAIModel(orefContext, isBuilderWindow());
            (window as any).WaveAIModel = WaveAIModel.instance;
        }
        return WaveAIModel.instance;
    }

    static resetInstance(): void {
        WaveAIModel.instance = null;
    }

    getUseChatEndpointUrl(): string {
        return `${getWebServerEndpoint()}/api/post-chat-message`;
    }

    async addFile(file: File): Promise<DroppedFile> {
        // Resize images before storing
        const processedFile = await resizeImage(file);

        const droppedFile: DroppedFile = {
            id: crypto.randomUUID(),
            file: processedFile,
            name: processedFile.name,
            type: processedFile.type,
            size: processedFile.size,
        };

        // Create 128x128 preview data URL for images
        if (processedFile.type.startsWith("image/")) {
            const previewDataUrl = await createImagePreview(processedFile);
            if (previewDataUrl) {
                droppedFile.previewUrl = previewDataUrl;
            }
        }

        const currentFiles = globalStore.get(this.droppedFiles);
        globalStore.set(this.droppedFiles, [...currentFiles, droppedFile]);

        return droppedFile;
    }

    async addFileFromRemoteUri(draggedFile: DraggedFile): Promise<void> {
        if (draggedFile.isDir) {
            this.setError("Cannot add directories to Hypheus. Please select a file.");
            return;
        }

        try {
            const fileInfo = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: draggedFile.uri } }, null);
            if (fileInfo.notfound) {
                this.setError(`File not found: ${draggedFile.relName}`);
                return;
            }
            if (fileInfo.isdir) {
                this.setError("Cannot add directories to Hypheus. Please select a file.");
                return;
            }

            const mimeType = fileInfo.mimetype || "application/octet-stream";
            const fileSize = fileInfo.size || 0;
            const sizeError = validateFileSizeFromInfo(draggedFile.relName, fileSize, mimeType);
            if (sizeError) {
                this.setError(formatFileSizeError(sizeError));
                return;
            }

            const fileData = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: draggedFile.uri } }, null);
            if (!fileData.data64) {
                this.setError(`Failed to read file: ${draggedFile.relName}`);
                return;
            }

            const buffer = base64ToArrayBuffer(fileData.data64);
            const file = new File([buffer], draggedFile.relName, { type: mimeType });
            if (!isAcceptableFile(file)) {
                this.setError(
                    `File type not supported: ${draggedFile.relName}. Supported: images, PDFs, and text/code files.`
                );
                return;
            }

            await this.addFile(file);
        } catch (error) {
            console.error("Error handling FILE_ITEM drop:", error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.setError(`Failed to add file: ${errorMsg}`);
        }
    }

    removeFile(fileId: string) {
        const currentFiles = globalStore.get(this.droppedFiles);
        const updatedFiles = currentFiles.filter((f) => f.id !== fileId);
        globalStore.set(this.droppedFiles, updatedFiles);
    }

    clearFiles() {
        const currentFiles = globalStore.get(this.droppedFiles);

        // Cleanup all preview URLs
        currentFiles.forEach((file) => {
            if (file.previewUrl) {
                URL.revokeObjectURL(file.previewUrl);
            }
        });

        globalStore.set(this.droppedFiles, []);
    }

    clearChat() {
        this.submissionVersion++;
        this.preparingSubmission = false;
        globalStore.set(this.submissionPending, false);
        this.useChatStop?.();
        this.clearFiles();
        this.clearError();
        globalStore.set(this.toolApprovalRequests, {});
        globalStore.set(this.isChatEmptyAtom, true);
        const newChatId = crypto.randomUUID();
        globalStore.set(this.chatId, newChatId);

        RpcApi.SetRTInfoCommand(TabRpcClient, {
            oref: this.orefContext,
            data: { "waveai:chatid": newChatId },
        });

        this.useChatSetMessages?.([]);
    }

    setError(message: string) {
        const accountError = isCroweSignInRequired(message)
            ? "signin"
            : isCroweLegacyKeyError(message)
              ? "legacykey"
              : null;
        globalStore.set(this.accountErrorAtom, accountError);
        globalStore.set(
            this.errorMessage,
            accountError === "signin"
                ? CroweSignInRequired
                : accountError === "legacykey"
                  ? "This advanced engine needs an API key. You can use your Crowe account instead."
                  : message
        );
    }

    clearError() {
        globalStore.set(this.errorMessage, null);
        globalStore.set(this.accountErrorAtom, null);
    }

    registerInputRef(ref: React.RefObject<AIPanelInputRef>) {
        this.inputRef = ref;
    }

    registerScrollToBottom(callback: () => void) {
        this.scrollToBottomCallback = callback;
    }

    registerUseChatData(
        sendMessage: UseChatSendMessageType,
        setMessages: UseChatSetMessagesType,
        status: ChatStatus,
        stop: () => void
    ) {
        this.useChatSendMessage = sendMessage;
        this.useChatSetMessages = setMessages;
        this.useChatStatus = status;
        this.useChatStop = stop;
    }

    scrollToBottom() {
        this.scrollToBottomCallback?.();
    }

    focusInput() {
        if (!this.inBuilder && !WorkspaceLayoutModel.getInstance().getAIPanelVisible()) {
            WorkspaceLayoutModel.getInstance().setAIPanelVisible(true);
        }
        if (this.inputRef?.current) {
            this.inputRef.current.focus();
        }
    }

    selectInputRange(start: number, end: number) {
        if (this.inputRef?.current) {
            this.inputRef.current.selectRange(start, end);
        }
    }

    async reloadChatFromBackend(chatIdValue: string): Promise<WaveUIMessage[]> {
        const chatData = await RpcApi.GetWaveAIChatCommand(TabRpcClient, { chatid: chatIdValue });
        const messages: UIMessage[] = chatData?.messages ?? [];
        globalStore.set(this.isChatEmptyAtom, messages.length === 0);
        return messages as WaveUIMessage[];
    }

    async stopResponse() {
        if (this.preparingSubmission) {
            this.submissionVersion++;
            this.preparingSubmission = false;
            globalStore.set(this.submissionPending, false);
            return;
        }
        this.useChatStop?.();
        await new Promise((resolve) => setTimeout(resolve, 500));

        const chatIdValue = globalStore.get(this.chatId);
        if (!chatIdValue) {
            return;
        }
        try {
            const messages = await this.reloadChatFromBackend(chatIdValue);
            this.useChatSetMessages?.(messages);
        } catch (error) {
            console.error("Failed to reload chat after stop:", error);
        }
    }

    getAndClearMessage(): AIMessage | null {
        const msg = this.realMessage;
        this.realMessage = null;
        return msg;
    }

    hasNonEmptyInput(): boolean {
        const input = globalStore.get(this.inputAtom);
        return input != null && input.trim().length > 0;
    }

    appendText(text: string, newLine?: boolean, opts?: { scrollToBottom?: boolean }) {
        const currentInput = globalStore.get(this.inputAtom);
        let newInput = currentInput;

        if (newInput.length > 0) {
            if (newLine) {
                if (!newInput.endsWith("\n")) {
                    newInput += "\n";
                }
            } else if (!newInput.endsWith(" ") && !newInput.endsWith("\n")) {
                newInput += " ";
            }
        }

        newInput += text;
        globalStore.set(this.inputAtom, newInput);

        if (opts?.scrollToBottom && this.inputRef?.current) {
            setTimeout(() => this.inputRef.current.scrollToBottom(), 10);
        }
    }

    setModel(model: string) {
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: this.orefContext,
            meta: { "waveai:model": model },
        });
    }

    setWidgetAccess(enabled: boolean) {
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: this.orefContext,
            meta: { "waveai:widgetcontext": enabled },
        });
    }

    isValidMode(mode: string): boolean {
        const aiModeConfigs = globalStore.get(this.aiModeConfigs);
        if (aiModeConfigs == null || !(mode in aiModeConfigs)) {
            return false;
        }

        return true;
    }

    setAIMode(mode: string) {
        if (!this.isValidMode(mode)) {
            this.setAIModeToDefault();
        } else {
            globalStore.set(this.currentAIMode, mode);
            RpcApi.SetRTInfoCommand(TabRpcClient, {
                oref: this.orefContext,
                data: { "waveai:mode": mode },
            });
        }
    }

    setAIModeToDefault() {
        const defaultMode = globalStore.get(this.defaultModeAtom);
        globalStore.set(this.currentAIMode, defaultMode);
        RpcApi.SetRTInfoCommand(TabRpcClient, {
            oref: this.orefContext,
            data: { "waveai:mode": null },
        });
    }

    async fixModeAfterConfigChange(): Promise<void> {
        const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
            oref: this.orefContext,
        });
        const mode = rtInfo?.["waveai:mode"];
        if (mode == null || !this.isValidMode(mode)) {
            this.setAIModeToDefault();
        }
    }

    async getRTInfo(): Promise<Record<string, any>> {
        const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
            oref: this.orefContext,
        });
        return rtInfo ?? {};
    }

    async loadInitialChat(): Promise<WaveUIMessage[]> {
        const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
            oref: this.orefContext,
        });
        let chatIdValue = rtInfo?.["waveai:chatid"];
        if (chatIdValue == null) {
            chatIdValue = crypto.randomUUID();
            RpcApi.SetRTInfoCommand(TabRpcClient, {
                oref: this.orefContext,
                data: { "waveai:chatid": chatIdValue },
            });
        }
        globalStore.set(this.chatId, chatIdValue);

        const aiModeValue = rtInfo?.["waveai:mode"];
        if (aiModeValue == null) {
            const defaultMode = globalStore.get(this.defaultModeAtom);
            globalStore.set(this.currentAIMode, defaultMode);
        } else if (this.isValidMode(aiModeValue)) {
            globalStore.set(this.currentAIMode, aiModeValue);
        } else {
            this.setAIModeToDefault();
        }

        try {
            return await this.reloadChatFromBackend(chatIdValue);
        } catch (error) {
            console.error("Failed to load chat:", error);
            this.setError("Failed to load chat. Starting new chat...");

            this.clearChat();
            return [];
        }
    }

    async handleSubmit() {
        const action = getComposerAction(this.useChatStatus, globalStore.get(this.composerState));
        if (action === "connect") {
            this.setError(CroweSignInRequired);
            this.openCroweAccount();
            return;
        }
        if (action !== "send") return;

        const input = globalStore.get(this.inputAtom);
        const droppedFiles = globalStore.get(this.droppedFiles);
        if (input.trim() === "/clear" || input.trim() === "/new") {
            this.clearChat();
            globalStore.set(this.inputAtom, "");
            return;
        }
        if (!this.useChatSendMessage) return;

        const currentMode = globalStore.get(this.currentAIMode);
        const modeConfig = globalStore.get(this.aiModeConfigs)?.[currentMode];
        const chatid = globalStore.get(this.chatId);
        const version = ++this.submissionVersion;
        this.preparingSubmission = true;
        globalStore.set(this.submissionPending, true);
        let draftEdited = false;
        let responseOwnsPending = false;
        const finishPending = () => {
            if (version !== this.submissionVersion) return;
            this.preparingSubmission = false;
            globalStore.set(this.submissionPending, false);
        };
        const unsubscribe = globalStore.sub(this.inputAtom, () => {
            draftEdited = true;
        });
        this.clearError();

        try {
            const aiMessageParts: AIMessagePart[] = [];
            const uiMessageParts: WaveUIMessagePart[] = [];

            if (input.trim()) {
                aiMessageParts.push({ type: "text", text: input.trim() });
                uiMessageParts.push({ type: "text", text: input.trim() });
            }

            for (const droppedFile of droppedFiles) {
                const normalizedMimeType = normalizeMimeType(droppedFile.file);
                const dataUrl = await createDataUrl(droppedFile.file);
                if (version !== this.submissionVersion) return;

                aiMessageParts.push({
                    type: "file",
                    filename: droppedFile.name,
                    mimetype: normalizedMimeType,
                    url: dataUrl,
                    size: droppedFile.file.size,
                    previewurl: droppedFile.previewUrl,
                });

                uiMessageParts.push({
                    type: "data-userfile",
                    data: {
                        filename: droppedFile.name,
                        mimetype: normalizedMimeType,
                        size: droppedFile.file.size,
                        previewurl: droppedFile.previewUrl,
                    },
                });
            }

            if (
                version !== this.submissionVersion ||
                currentMode !== globalStore.get(this.currentAIMode) ||
                chatid !== globalStore.get(this.chatId) ||
                droppedFiles.some((file) => !globalStore.get(this.droppedFiles).includes(file))
            )
                return;
            const state = globalStore.get(this.composerState);
            if (getComposerAction(this.useChatStatus, { ...state, pending: false, localCommand: false }) !== "send") {
                if (state.needsConnection) {
                    this.setError(CroweSignInRequired);
                    this.openCroweAccount();
                }
                return;
            }

            const realMessage: AIMessage = {
                messageid: crypto.randomUUID(),
                parts: aiMessageParts,
            };
            this.realMessage = realMessage;

            // console.log("SUBMIT MESSAGE", realMessage);

            const accountMode = isCroweAccountMode(currentMode, modeConfig);
            if (accountMode) {
                this.accountSubmissions.set(realMessage.messageid, {
                    chatid,
                    messageid: realMessage.messageid,
                    input,
                    files: droppedFiles,
                });
            }
            this.preparingSubmission = false;
            globalStore.set(this.isChatEmptyAtom, false);
            if (!draftEdited) globalStore.set(this.inputAtom, "");
            // The submission owns previews until persistence is known or draft recovery takes ownership.
            globalStore.set(this.droppedFiles, (files) => files.filter((file) => !droppedFiles.includes(file)));
            if (!accountMode) {
                responseOwnsPending = true;
                // CLI submission acknowledges dispatch, not completion of a potentially long response.
                void (async () => {
                    try {
                        await this.useChatSendMessage({ id: realMessage.messageid, parts: uiMessageParts });
                    } catch (error) {
                        if (version === this.submissionVersion) {
                            this.setError(error instanceof Error ? error.message : String(error));
                        }
                    } finally {
                        try {
                            droppedFiles.forEach((file) => {
                                if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
                            });
                        } finally {
                            finishPending();
                        }
                    }
                })().catch(() => {});
                return;
            }
            try {
                await this.useChatSendMessage({ id: realMessage.messageid, parts: uiMessageParts });
            } finally {
                this.finishAccountSubmission(realMessage.messageid);
            }
        } catch (error) {
            if (version === this.submissionVersion) {
                this.setError(error instanceof Error ? error.message : String(error));
            }
        } finally {
            unsubscribe();
            if (!responseOwnsPending) finishPending();
        }
    }

    async fetchChat(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        let submission: AccountSubmission;
        try {
            const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
            submission = this.accountSubmissions.get(body?.msg?.messageid);
        } catch {}
        const response = await fetch(input, init);
        if (
            submission &&
            response.status === 401 &&
            (await response.clone().text()).trim() === CroweSignInRequired &&
            this.accountSubmissions.get(submission.messageid) === submission
        ) {
            this.accountSubmissions.delete(submission.messageid);
            globalStore.set(this.unsentAccountDrafts, (drafts) => [...drafts, submission]);
            if (globalStore.get(this.chatId) === submission.chatid) {
                this.useChatSetMessages?.((messages) =>
                    messages.filter((message) => message.role !== "user" || message.id !== submission.messageid)
                );
            }
        }
        return response;
    }

    finishAccountSubmission(messageid: string) {
        const submission = this.accountSubmissions.get(messageid);
        if (!submission) return;
        this.accountSubmissions.delete(messageid);
        submission.files.forEach((file) => {
            if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        });
    }

    restoreAccountDraft(messageid: string): boolean {
        const draft = globalStore.get(this.unsentAccountDrafts).find((item) => item.messageid === messageid);
        if (!draft || globalStore.get(this.inputAtom) || globalStore.get(this.droppedFiles).length > 0) return false;
        if (globalStore.get(this.chatId) === draft.chatid) {
            this.useChatSetMessages?.((messages) =>
                messages.filter((message) => message.role !== "user" || message.id !== messageid)
            );
        }
        globalStore.set(this.inputAtom, draft.input);
        globalStore.set(this.droppedFiles, draft.files);
        globalStore.set(this.unsentAccountDrafts, (drafts) => drafts.filter((item) => item.messageid !== messageid));
        return true;
    }

    discardAccountDraft(messageid: string) {
        const draft = globalStore.get(this.unsentAccountDrafts).find((item) => item.messageid === messageid);
        if (!draft) return;
        draft.files.forEach((file) => {
            if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        });
        globalStore.set(this.unsentAccountDrafts, (drafts) => drafts.filter((item) => item.messageid !== messageid));
    }

    async uiLoadInitialChat() {
        globalStore.set(this.isLoadingChatAtom, true);
        const messages = await this.loadInitialChat();
        this.useChatSetMessages?.(messages);
        globalStore.set(this.isLoadingChatAtom, false);
        setTimeout(() => {
            this.scrollToBottom();
        }, 100);
    }

    async ensureRateLimitSet() {
        const currentInfo = globalStore.get(atoms.waveAIRateLimitInfoAtom);
        if (currentInfo != null) {
            return;
        }
        try {
            const rateLimitInfo = await RpcApi.GetWaveAIRateLimitCommand(TabRpcClient);
            if (rateLimitInfo != null) {
                globalStore.set(atoms.waveAIRateLimitInfoAtom, rateLimitInfo);
            }
        } catch (error) {
            console.error("Failed to fetch rate limit info:", error);
        }
    }

    handleAIFeedback(feedback: "good" | "bad") {
        RpcApi.RecordTEventCommand(
            TabRpcClient,
            {
                event: "waveai:feedback",
                props: {
                    "waveai:feedback": feedback,
                },
            },
            { noresponse: true }
        );
    }

    requestWaveAIFocus() {
        if (this.inBuilder) {
            BuilderFocusManager.getInstance().setWaveAIFocused();
        } else {
            FocusManager.getInstance().requestWaveAIFocus();
        }
    }

    requestNodeFocus() {
        if (this.inBuilder) {
            BuilderFocusManager.getInstance().setAppFocused();
        } else {
            FocusManager.getInstance().requestNodeFocus();
        }
    }

    getChatId(): string {
        return globalStore.get(this.chatId);
    }

    async toolUseSendApproval(toolcallid: string, approval: ToolApprovalDecision): Promise<void> {
        if (!toolcallid || (approval !== "user-approved" && approval !== "user-denied")) {
            throw new Error("Invalid approval request");
        }
        const previous = globalStore.get(this.toolApprovalRequests)[toolcallid];
        if (previous?.status === "pending" || previous?.status === "submitted") {
            return;
        }
        const pending: ToolApprovalRequest = { status: "pending", decision: approval };
        globalStore.set(this.toolApprovalRequests, (requests) => ({ ...requests, [toolcallid]: pending }));
        const finish = (state: ToolApprovalRequest) => {
            globalStore.set(this.toolApprovalRequests, (requests) =>
                requests[toolcallid] === pending ? { ...requests, [toolcallid]: state } : requests
            );
        };
        try {
            await RpcApi.WaveAIToolApproveCommand(TabRpcClient, { toolcallid, approval }, { timeout: 10000 });
            finish({ status: "submitted", decision: approval });
        } catch (error) {
            finish({
                status: "error",
                decision: approval,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async openDiff(fileName: string, toolcallid: string) {
        const chatId = this.getChatId();

        if (!chatId || !fileName) {
            console.error("Missing chatId or fileName for opening diff", chatId, fileName);
            return;
        }

        const blockDef: BlockDef = {
            meta: {
                view: "aifilediff",
                file: fileName,
                "aifilediff:chatid": chatId,
                "aifilediff:toolcallid": toolcallid,
            },
        };
        await createBlock(blockDef, false, true);
    }

    openCroweAccount() {
        if (!this.inBuilder) {
            DockModel.getInstance().collapse();
            WorkspaceLayoutModel.getInstance().setAIPanelVisible(true);
        }
        CroweAccountModel.getInstance().showSetup();
    }

    openEngineSelector() {
        if (this.inBuilder) return;
        WorkspaceLayoutModel.getInstance().setAIPanelVisible(true);
        const dock = DockModel.getInstance();
        if (globalStore.get(dock.activeToolAtom) !== "model" || globalStore.get(dock.collapsedAtom)) {
            dock.toggle("model");
        }
    }

    useCroweAccount() {
        this.setAIMode(CroweAccountMode);
        this.clearError();
        this.openCroweAccount();
    }

    async useCroweAccountByDefault() {
        if (this.inBuilder || globalStore.get(this.croweDefaultSaveStatus) === "saving") return;
        globalStore.set(this.croweDefaultSaveError, "");
        globalStore.set(this.croweDefaultSaveStatus, "saving");
        try {
            await RpcApi.SetConfigCommand(TabRpcClient, { "waveai:defaultmode": CroweAccountMode });
        } catch {
            globalStore.set(this.croweDefaultSaveError, "Could not confirm your default engine was saved. Try again.");
            globalStore.set(this.croweDefaultSaveStatus, "error");
            return;
        }
        globalStore.set(this.croweDefaultSaveStatus, "saved");
    }

    openRestoreBackupModal(toolcallid: string) {
        globalStore.set(this.restoreBackupModalToolCallId, toolcallid);
    }

    closeRestoreBackupModal() {
        globalStore.set(this.restoreBackupModalToolCallId, null);
        globalStore.set(this.restoreBackupStatus, "idle");
        globalStore.set(this.restoreBackupError, null);
    }

    async restoreBackup(toolcallid: string, backupFilePath: string, restoreToFileName: string) {
        globalStore.set(this.restoreBackupStatus, "processing");
        globalStore.set(this.restoreBackupError, null);
        try {
            await RpcApi.FileRestoreBackupCommand(TabRpcClient, {
                backupfilepath: backupFilePath,
                restoretofilename: restoreToFileName,
            });
            console.log("Backup restored successfully:", { toolcallid, backupFilePath, restoreToFileName });
            globalStore.set(this.restoreBackupStatus, "success");
        } catch (error) {
            console.error("Failed to restore backup:", error);
            const errorMsg = error?.message || String(error);
            globalStore.set(this.restoreBackupError, errorMsg);
            globalStore.set(this.restoreBackupStatus, "error");
        }
    }

    canCloseWaveAIPanel(): boolean {
        if (this.inBuilder) {
            return false;
        }
        return true;
    }

    closeWaveAIPanel() {
        if (this.inBuilder) {
            return;
        }
        WorkspaceLayoutModel.getInstance().setAIPanelVisible(false);
    }
}
