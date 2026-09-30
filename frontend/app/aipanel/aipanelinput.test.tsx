// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { Children, isValidElement, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as AIUtils from "./ai-utils";
import { AIPanelInput } from "./aipanelinput";
import { CroweAccountMode, CroweAccountModel } from "./croweaccount-model";
import { DroppedFile, getComposerAction, WaveAIModel } from "./waveai-model";

vi.mock("react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("react")>()),
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
    useRef: (current: unknown) => ({ current }),
}));
vi.mock("jotai", async (importOriginal) => ({
    ...(await importOriginal<typeof import("jotai")>()),
    useAtomValue: (value: any) => globalStore.get(value),
    useAtom: (value: any) => [globalStore.get(value), (next: any) => globalStore.set(value, next)],
}));
vi.mock("@/element/tooltip", () => ({ Tooltip: ({ children }: any) => children }));

let model: WaveAIModel;
let account: CroweAccountModel;
let attachment: DroppedFile;

beforeEach(() => {
    vi.restoreAllMocks();
    if (!atoms) {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        initGlobalAtoms({ tabId: "test", windowId: "test" } as GlobalInitOptions);
        log.mockRestore();
    }
    CroweAccountModel.resetInstance();
    account = CroweAccountModel.getInstance();
    account.applyStatus({ state: "connected" });
    model = Reflect.construct(WaveAIModel, ["tab:composer", false]);
    model.currentAIMode = atom(CroweAccountMode);
    model.aiModeConfigs = atom({
        [CroweAccountMode]: { "display:name": "Crowe account", "ai:apitype": "crowe-gateway" },
    });
    model.isWaveAIFocusedAtom = atom(false);
    model.widgetAccessAtom = atom(false);
    model.panelVisibleAtom = atom(true);
    globalStore.set(model.chatId, "chat");
    model.useChatSendMessage = vi.fn().mockResolvedValue(undefined);
    model.useChatStop = vi.fn();
    vi.spyOn(model, "openCroweAccount").mockImplementation(() => account.showSetup());
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    attachment = {
        id: "attachment",
        name: "draft.txt",
        type: "text/plain",
        size: 8,
        file: new File(["contents"], "draft.txt", { type: "text/plain" }),
        previewUrl: "blob:preview",
    };
    vi.spyOn(AIUtils, "createDataUrl").mockResolvedValue("data:text/plain;base64,Y29udGVudHM=");
});

afterEach(() => CroweAccountModel.resetInstance());

function tree(status = model.useChatStatus) {
    return (AIPanelInput as any).type({
        model,
        status,
        onSubmit: () => model.handleSubmit(),
    }) as ReactElement;
}

function find(element: ReactElement, predicate: (node: ReactElement<any>) => boolean): ReactElement<any> {
    if (predicate(element)) return element;
    for (const child of Children.toArray((element.props as any).children)) {
        if (!isValidElement(child)) continue;
        const result = find(child, predicate);
        if (result) return result;
    }
    return null;
}

function submit(element: ReactElement, path: "button" | "enter") {
    if (path === "button") {
        const button = find(element, (node) => node.props["aria-label"] === "Send");
        if (button && !button.props.disabled) {
            find(element, (node) => node.type === "form").props.onSubmit({ preventDefault: vi.fn() });
        }
        return;
    }
    find(element, (node) => node.type === "textarea").props.onKeyDown({
        key: "Enter",
        shiftKey: false,
        nativeEvent: {},
        preventDefault: vi.fn(),
    });
}

describe("composer policy and controls", () => {
    it.each(["ready", "error"])("allows text and attachment-only sends from %s through both paths", async (status) => {
        for (const content of ["text", "file"]) {
            for (const path of ["button", "enter"] as const) {
                model.useChatStatus = status as any;
                globalStore.set(model.inputAtom, content === "text" ? "Explain this" : "");
                globalStore.set(model.droppedFiles, content === "file" ? [attachment] : []);
                expect(getComposerAction(status, globalStore.get(model.composerState))).toBe("send");
                const before = vi.mocked(model.useChatSendMessage).mock.calls.length;
                submit(tree(), path);
                await vi.waitFor(() => expect(vi.mocked(model.useChatSendMessage).mock.calls.length).toBe(before + 1));
                await vi.waitFor(() => expect(globalStore.get(model.submissionPending)).toBe(false));
            }
        }
    });

    it("returns after dispatching a local stream while retaining the lock and preview ownership", async () => {
        globalStore.set(model.currentAIMode, "local");
        globalStore.set(model.inputAtom, "original");
        globalStore.set(model.droppedFiles, [attachment]);
        let finish: () => void;
        const response = new Promise<void>((resolve) => {
            finish = resolve;
        });
        vi.mocked(model.useChatSendMessage).mockReturnValue(response);
        await model.handleSubmit();
        expect(model.useChatSendMessage).toHaveBeenCalledOnce();
        expect(globalStore.get(model.submissionPending)).toBe(true);
        expect(globalStore.get(model.inputAtom)).toBe("");
        expect(globalStore.get(model.droppedFiles)).toEqual([]);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        globalStore.set(model.inputAtom, "next prompt");
        await model.handleSubmit();
        expect(model.useChatSendMessage).toHaveBeenCalledOnce();
        finish();
        await vi.waitFor(() => expect(globalStore.get(model.submissionPending)).toBe(false));
        expect(globalStore.get(model.inputAtom)).toBe("next prompt");
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(attachment.previewUrl);
    });

    it.each(["sync", "async"])("handles a %s local dispatch failure and releases ownership", async (kind) => {
        globalStore.set(model.currentAIMode, "local");
        globalStore.set(model.droppedFiles, [attachment]);
        if (kind === "sync") {
            vi.mocked(model.useChatSendMessage).mockImplementation(() => {
                throw new Error("dispatch failed");
            });
        } else {
            vi.mocked(model.useChatSendMessage).mockRejectedValue(new Error("dispatch failed"));
        }
        await model.handleSubmit();
        await vi.waitFor(() => expect(globalStore.get(model.submissionPending)).toBe(false));
        expect(globalStore.get(model.errorMessage)).toBe("dispatch failed");
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(attachment.previewUrl);
    });

    it("does not let an old local stream completion clear a newer lock or error", async () => {
        globalStore.set(model.currentAIMode, "local");
        globalStore.set(model.droppedFiles, [attachment]);
        let failFirst: (reason: Error) => void;
        let finishSecond: () => void;
        vi.mocked(model.useChatSendMessage)
            .mockReturnValueOnce(
                new Promise<void>((_resolve, reject) => {
                    failFirst = reject;
                })
            )
            .mockReturnValueOnce(
                new Promise<void>((resolve) => {
                    finishSecond = resolve;
                })
            );
        await model.handleSubmit();
        model.submissionVersion++;
        globalStore.set(model.submissionPending, false);
        globalStore.set(model.inputAtom, "next chat prompt");
        await model.handleSubmit();
        model.setError("newer error");
        failFirst(new Error("old stream error"));
        await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(attachment.previewUrl));
        expect(globalStore.get(model.submissionPending)).toBe(true);
        expect(globalStore.get(model.errorMessage)).toBe("newer error");
        finishSecond();
        await vi.waitFor(() => expect(globalStore.get(model.submissionPending)).toBe(false));
    });

    it.each(["empty", "loading", "submitted", "streaming"])("blocks both send paths for %s", async (state) => {
        globalStore.set(model.inputAtom, state === "empty" ? "   " : "draft");
        globalStore.set(model.isLoadingChatAtom, state === "loading");
        if (state === "submitted" || state === "streaming") model.useChatStatus = state;
        const element = tree();
        submit(element, "button");
        submit(element, "enter");
        await model.handleSubmit();
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        if (state === "submitted" || state === "streaming") {
            expect(find(element, (node) => node.props["aria-label"] === "Stop response")).not.toBeNull();
        }
    });

    it("labels the editable textarea and exposes an explicit Connect action without submitting", () => {
        account.applyStatus({ state: "signedout" });
        globalStore.set(model.inputAtom, "keep this draft");
        const element = tree();
        const textarea = find(element, (node) => node.type === "textarea");
        expect(textarea.props["aria-label"]).toBe("Message Hypheus");
        expect(textarea.props.disabled).toBeUndefined();
        expect(textarea.props.readOnly).toBeUndefined();
        submit(element, "enter");
        expect(model.openCroweAccount).not.toHaveBeenCalled();
        find(element, (node) => node.props["aria-label"] === "Connect Crowe account").props.onClick();
        expect(model.openCroweAccount).toHaveBeenCalledOnce();
        expect(renderToStaticMarkup(element)).toContain('aria-label="Message Hypheus"');
        account.applyStatus({ state: "connected" });
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(globalStore.get(model.inputAtom)).toBe("keep this draft");
    });

    it("keeps Shift+Enter and IME Enter from submitting", () => {
        globalStore.set(model.inputAtom, "draft");
        const keydown = find(tree(), (node) => node.type === "textarea").props.onKeyDown;
        for (const event of [{ shiftKey: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }]) {
            const preventDefault = vi.fn();
            keydown({ key: "Enter", nativeEvent: {}, preventDefault, ...event });
            expect(preventDefault).not.toHaveBeenCalled();
        }
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
    });

    it("guards before asynchronous file conversion, shows Stop immediately, and preserves newer edits", async () => {
        let finish: (url: string) => void;
        vi.mocked(AIUtils.createDataUrl).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            })
        );
        globalStore.set(model.inputAtom, "original");
        globalStore.set(model.droppedFiles, [attachment]);
        const submission = model.handleSubmit();
        expect(globalStore.get(model.submissionPending)).toBe(true);
        expect(find(tree(), (node) => node.props["aria-label"] === "Stop response")).not.toBeNull();
        await model.handleSubmit();
        expect(AIUtils.createDataUrl).toHaveBeenCalledTimes(1);
        globalStore.set(model.inputAtom, "new text");
        globalStore.set(model.inputAtom, "original");
        const newer = { ...attachment, id: "newer", previewUrl: "blob:newer" };
        globalStore.set(model.droppedFiles, [attachment, newer]);
        finish("data:text/plain;base64,Y29udGVudHM=");
        await submission;
        expect(model.useChatSendMessage).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.inputAtom)).toBe("original");
        expect(globalStore.get(model.droppedFiles)).toEqual([newer]);
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview");
    });

    it("cancels preparation without consuming text, Files, or previews", async () => {
        let finish: (url: string) => void;
        vi.mocked(AIUtils.createDataUrl).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            })
        );
        globalStore.set(model.inputAtom, "draft");
        globalStore.set(model.droppedFiles, [attachment]);
        const submission = model.handleSubmit();
        find(tree(), (node) => node.props["aria-label"] === "Stop response").props.onClick();
        finish("data:text/plain;base64,Y29udGVudHM=");
        await submission;
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(globalStore.get(model.inputAtom)).toBe("draft");
        expect(globalStore.get(model.droppedFiles)[0].file).toBe(attachment.file);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        expect(globalStore.get(model.submissionPending)).toBe(false);
    });

    it("does not send an attachment removed during conversion or revoke its preview again", async () => {
        let finish: (url: string) => void;
        vi.mocked(AIUtils.createDataUrl).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            })
        );
        globalStore.set(model.inputAtom, "draft");
        globalStore.set(model.droppedFiles, [attachment]);
        const submission = model.handleSubmit();
        model.clearFiles();
        finish("data:text/plain;base64,Y29udGVudHM=");
        await submission;
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(globalStore.get(model.inputAtom)).toBe("draft");
        expect(globalStore.get(model.droppedFiles)).toEqual([]);
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(attachment.previewUrl);
        expect(globalStore.get(model.submissionPending)).toBe(false);
    });

    it("does not let a cancelled preparation release the next submission's guard", async () => {
        const finish: ((url: string) => void)[] = [];
        vi.mocked(AIUtils.createDataUrl).mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish.push(resolve);
                })
        );
        globalStore.set(model.droppedFiles, [attachment]);
        const first = model.handleSubmit();
        await model.stopResponse();
        const second = model.handleSubmit();
        finish[0]("data:text/plain;base64,Y29udGVudHM=");
        await first;
        expect(globalStore.get(model.submissionPending)).toBe(true);
        await model.handleSubmit();
        expect(AIUtils.createDataUrl).toHaveBeenCalledTimes(2);
        finish[1]("data:text/plain;base64,Y29udGVudHM=");
        await second;
        expect(model.useChatSendMessage).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.submissionPending)).toBe(false);
    });

    it.each(["/clear", "/new"])(
        "executes %s locally while disconnected without sending or connecting",
        async (command) => {
            account.applyStatus({ state: "signedout" });
            vi.spyOn(model, "clearChat").mockImplementation(() => {});
            globalStore.set(model.isLoadingChatAtom, true);
            globalStore.set(model.inputAtom, command);
            submit(tree(), "enter");
            expect(model.clearChat).toHaveBeenCalledOnce();
            expect(model.openCroweAccount).not.toHaveBeenCalled();
            expect(model.useChatSendMessage).not.toHaveBeenCalled();
            expect(globalStore.get(model.inputAtom)).toBe("");
        }
    );

    it.each(["submitted", "streaming"])("stops a %s request through the visible action", async (status) => {
        vi.useFakeTimers();
        try {
            model.useChatStatus = status as any;
            vi.spyOn(model, "reloadChatFromBackend").mockResolvedValue([]);
            find(tree(), (node) => node.props["aria-label"] === "Stop response").props.onClick();
            expect(model.useChatStop).toHaveBeenCalledOnce();
            await vi.runAllTimersAsync();
        } finally {
            vi.useRealTimers();
        }
    });

    it("retains the draft on conversion failure and releases the guard", async () => {
        globalStore.set(model.droppedFiles, [attachment]);
        vi.mocked(AIUtils.createDataUrl).mockRejectedValue(new Error("Could not read attachment"));
        await model.handleSubmit();
        expect(globalStore.get(model.errorMessage)).toBe("Could not read attachment");
        expect(globalStore.get(model.droppedFiles)[0].file).toBe(attachment.file);
        expect(globalStore.get(model.submissionPending)).toBe(false);
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it("rechecks account readiness after conversion without automatic retry", async () => {
        globalStore.set(model.droppedFiles, [attachment]);
        vi.mocked(AIUtils.createDataUrl).mockImplementation(async () => {
            account.applyStatus({ state: "expired" });
            return "data:text/plain;base64,Y29udGVudHM=";
        });
        await model.handleSubmit();
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
        expect(globalStore.get(model.droppedFiles)[0].file).toBe(attachment.file);
        account.applyStatus({ state: "connected" });
        expect(model.useChatSendMessage).not.toHaveBeenCalled();
    });
});
