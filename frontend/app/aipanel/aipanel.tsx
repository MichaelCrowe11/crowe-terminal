// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { handleWaveAIContextMenu } from "@/app/aipanel/aipanel-contextmenu";
import { waveAIHasSelection } from "@/app/aipanel/waveai-focus-utils";
import { useTabBackground } from "@/app/block/blockutil";
import { ErrorBoundary } from "@/app/element/errorboundary";
import { atoms, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { useTabModelMaybe } from "@/app/store/tab-model";
import { isBuilderWindow } from "@/app/store/windowtype";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { checkKeyPressed, keydownWrapper } from "@/util/keyutil";
import { isMacOS, isWindows } from "@/util/platformutil";
import { cn } from "@/util/util";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import * as jotai from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useDrop } from "react-dnd";
import { formatFileSizeError, isAcceptableFile, validateFileSize } from "./ai-utils";
import { AIDroppedFiles } from "./aidroppedfiles";
import { AIModeDropdown } from "./aimode";
import { AIPanelHeader } from "./aipanelheader";
import { AIPanelInput } from "./aipanelinput";
import { AIPanelMessages } from "./aipanelmessages";
import { AIRateLimitStrip } from "./airatelimitstrip";
import { WaveUIMessage } from "./aitypes";
import { BYOKAnnouncement } from "./byokannouncement";
import { TelemetryRequiredMessage } from "./telemetryrequired";
import { WaveAIModel } from "./waveai-model";

const AIBlockMask = memo(() => {
    return (
        <div
            key="block-mask"
            className="absolute top-0 left-0 right-0 bottom-0 border-1 border-transparent pointer-events-auto select-none p-0.5"
            style={{
                borderRadius: "var(--block-border-radius)",
                zIndex: "var(--zindex-block-mask-inner)",
            }}
        >
            <div
                className="w-full mt-[44px] h-[calc(100%-44px)] flex items-center justify-center"
                style={{
                    backgroundColor: "rgb(from var(--block-bg-color) r g b / 50%)",
                }}
            >
                <div className="font-bold opacity-70 mt-[-25%] text-[60px]">0</div>
            </div>
        </div>
    );
});

AIBlockMask.displayName = "AIBlockMask";

const AIDragOverlay = memo(() => {
    return (
        <div
            key="drag-overlay"
            className="absolute inset-0 bg-accent/20 border-2 border-dashed border-accent rounded-lg flex items-center justify-center z-10 p-4"
        >
            <div className="text-accent text-center">
                <i className="fa fa-upload text-3xl mb-2"></i>
                <div className="text-lg font-semibold">Drop files here</div>
                <div className="text-sm">Images, PDFs, and text/code files supported</div>
            </div>
        </div>
    );
});

AIDragOverlay.displayName = "AIDragOverlay";

const PROMPT_HINTS: { label: string; insert: string }[] = [
    { label: "explain this terminal output", insert: "Explain what just happened in this terminal." },
    { label: "open file as Crowe Code block", insert: "Open the file at <path> as a new Crowe Code block." },
    { label: "audit the current directory", insert: "Audit the current directory: list project shape, recent edits, anything risky." },
];

const AIWelcomeMessage = memo(() => {
    const modKey = isMacOS() ? "⌘" : "Alt";
    const focusKeys = isWindows() ? "Alt 0" : "Ctrl Shift 0";
    const aiModeConfigs = jotai.useAtomValue(atoms.waveaiModeConfigAtom);
    const hasCustomModes = Object.keys(aiModeConfigs).some((key) => !key.startsWith("waveai@"));

    const insertPrompt = (text: string) => {
        const model = WaveAIModel.getInstance();
        globalStore.set(model.inputAtom, text);
        model.focusInput();
    };

    return (
        <div className="px-4 py-6 max-w-md mx-auto">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#bfa669]/70">
                crowe logic
            </div>
            <div className="mt-1 font-mono text-[13px] text-foreground/90">
                <span className="text-[#bfa669]">$</span> ready
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-zinc-400">
                Type a request below, or pick a starter to drop it into the input.
            </p>

            <div className="mt-5 border-t border-[#bfa669]/15">
                {PROMPT_HINTS.map((hint) => (
                    <button
                        key={hint.label}
                        onClick={() => insertPrompt(hint.insert)}
                        className="group w-full flex items-center justify-between gap-3 py-2.5 border-b border-[#bfa669]/10 text-left cursor-pointer hover:bg-[#bfa669]/[0.06] transition-colors px-1"
                    >
                        <span className="font-mono text-[12px] text-[#bfa669] truncate">
                            {hint.label}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500 group-hover:text-[#bfa669] transition-colors">
                            insert &rarr;
                        </span>
                    </button>
                ))}
            </div>

            {!hasCustomModes && (
                <div className="mt-5">
                    <BYOKAnnouncement />
                </div>
            )}

            <div className="mt-6 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                <span>{modKey} K new</span>
                <span>{modKey} ⇧ A toggle</span>
                <span>{focusKeys} focus</span>
            </div>
        </div>
    );
});

AIWelcomeMessage.displayName = "AIWelcomeMessage";

const AIBuilderWelcomeMessage = memo(() => {
    return (
        <div className="text-secondary py-8">
            <div className="text-center">
                <i className="fa fa-sparkles text-4xl text-accent mb-4 block"></i>
                <p className="text-lg font-bold text-primary">Crowe App Builder</p>
            </div>
            <div className="mt-4 text-left max-w-md mx-auto">
                <p className="text-sm mb-6">
                    The Crowe App builder helps create custom widgets that integrate seamlessly into Crowe Terminal.
                </p>
            </div>
        </div>
    );
});

AIBuilderWelcomeMessage.displayName = "AIBuilderWelcomeMessage";

const AIErrorMessage = memo(() => {
    const model = WaveAIModel.getInstance();
    const errorMessage = jotai.useAtomValue(model.errorMessage);

    if (!errorMessage) {
        return null;
    }

    return (
        <div className="px-4 py-2 text-red-400 bg-red-900/20 border-l-4 border-red-500 mx-2 mb-2 relative">
            <button
                onClick={() => model.clearError()}
                className="absolute top-2 right-2 text-red-400 hover:text-red-300 cursor-pointer z-10"
                aria-label="Close error"
            >
                <i className="fa fa-times text-sm"></i>
            </button>
            <div className="text-sm pr-6 max-h-[100px] overflow-y-auto">
                {errorMessage}
                <button
                    onClick={() => model.clearChat()}
                    className="ml-2 text-xs text-red-300 hover:text-red-200 cursor-pointer underline"
                >
                    New Chat
                </button>
            </div>
        </div>
    );
});

AIErrorMessage.displayName = "AIErrorMessage";

const ConfigChangeModeFixer = memo(() => {
    const model = WaveAIModel.getInstance();
    const telemetryEnabled = jotai.useAtomValue(getSettingsKeyAtom("telemetry:enabled")) ?? false;
    const aiModeConfigs = jotai.useAtomValue(model.aiModeConfigs);

    useEffect(() => {
        model.fixModeAfterConfigChange();
    }, [telemetryEnabled, aiModeConfigs, model]);

    return null;
});

ConfigChangeModeFixer.displayName = "ConfigChangeModeFixer";

type AIPanelComponentInnerProps = {
    roundTopLeft: boolean;
};

const AIPanelComponentInner = memo(({ roundTopLeft }: AIPanelComponentInnerProps) => {
    const [isDragOver, setIsDragOver] = useState(false);
    const [isReactDndDragOver, setIsReactDndDragOver] = useState(false);
    const [initialLoadDone, setInitialLoadDone] = useState(false);
    const model = WaveAIModel.getInstance();
    const containerRef = useRef<HTMLDivElement>(null);
    const waveEnv = useWaveEnv();
    const isLayoutMode = jotai.useAtomValue(atoms.controlShiftDelayAtom);
    const showOverlayBlockNums = jotai.useAtomValue(getSettingsKeyAtom("app:showoverlayblocknums")) ?? true;
    const isFocused = jotai.useAtomValue(model.isWaveAIFocusedAtom);
    const focusFollowsCursorMode = jotai.useAtomValue(getSettingsKeyAtom("app:focusfollowscursor")) ?? "off";
    const telemetryEnabled = jotai.useAtomValue(getSettingsKeyAtom("telemetry:enabled")) ?? false;
    const isPanelVisible = jotai.useAtomValue(model.getPanelVisibleAtom());
    const tabModel = useTabModelMaybe();
    const [tabBorderColor, tabActiveBorderColor] = useTabBackground(waveEnv, tabModel?.tabId);
    const defaultMode = jotai.useAtomValue(getSettingsKeyAtom("waveai:defaultmode")) ?? "waveai@crowelm-auto";
    const aiModeConfigs = jotai.useAtomValue(model.aiModeConfigs);

    const hasCustomModes = Object.keys(aiModeConfigs).some((key) => !key.startsWith("waveai@"));
    const isUsingCustomMode = !defaultMode.startsWith("waveai@");
    const allowAccess = telemetryEnabled || (hasCustomModes && isUsingCustomMode);

    const { messages, sendMessage, status, setMessages, error, stop } = useChat<WaveUIMessage>({
        transport: new DefaultChatTransport({
            api: model.getUseChatEndpointUrl(),
            prepareSendMessagesRequest: (_opts) => {
                const msg = model.getAndClearMessage();
                const body: any = {
                    msg,
                    chatid: globalStore.get(model.chatId),
                    widgetaccess: globalStore.get(model.widgetAccessAtom),
                    aimode: globalStore.get(model.currentAIMode),
                };
                if (isBuilderWindow()) {
                    body.builderid = globalStore.get(atoms.builderId);
                    body.builderappid = globalStore.get(atoms.builderAppId);
                } else {
                    body.tabid = tabModel.tabId;
                }
                return { body };
            },
        }),
        onError: (error) => {
            console.error("AI Chat error:", error);
            model.setError(error.message || "An error occurred");
        },
    });

    model.registerUseChatData(sendMessage, setMessages, status, stop);

    // console.log("AICHAT messages", messages);
    (window as any).aichatmessages = messages;
    (window as any).aichatstatus = status;

    const handleKeyDown = (waveEvent: WaveKeyboardEvent): boolean => {
        if (checkKeyPressed(waveEvent, "Cmd:k")) {
            model.clearChat();
            return true;
        }
        return false;
    };

    useEffect(() => {
        globalStore.set(model.isAIStreaming, status === "streaming" || status === "submitted");
    }, [status]);

    useEffect(() => {
        const keyHandler = keydownWrapper(handleKeyDown);
        document.addEventListener("keydown", keyHandler);
        return () => {
            document.removeEventListener("keydown", keyHandler);
        };
    }, []);

    useEffect(() => {
        const loadChat = async () => {
            await model.uiLoadInitialChat();
            setInitialLoadDone(true);
        };
        loadChat();
    }, [model]);

    useEffect(() => {
        const updateWidth = () => {
            if (containerRef.current) {
                globalStore.set(model.containerWidth, containerRef.current.offsetWidth);
            }
        };

        updateWidth();

        const resizeObserver = new ResizeObserver(updateWidth);
        if (containerRef.current) {
            resizeObserver.observe(containerRef.current);
        }

        return () => {
            resizeObserver.disconnect();
        };
    }, [model]);

    useEffect(() => {
        model.ensureRateLimitSet();
    }, [model]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        await model.handleSubmit();
        setTimeout(() => {
            model.focusInput();
        }, 100);
    };

    const hasFilesDragged = (dataTransfer: DataTransfer): boolean => {
        // Check if the drag operation contains files by looking at the types
        return dataTransfer.types.includes("Files");
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!allowAccess) {
            return;
        }

        const hasFiles = hasFilesDragged(e.dataTransfer);

        // Only handle native file drags here, let react-dnd handle FILE_ITEM drags
        if (!hasFiles) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        if (!isDragOver) {
            setIsDragOver(true);
        }
    };

    const handleDragEnter = (e: React.DragEvent) => {
        if (!allowAccess) {
            return;
        }

        const hasFiles = hasFilesDragged(e.dataTransfer);

        // Only handle native file drags here, let react-dnd handle FILE_ITEM drags
        if (!hasFiles) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        setIsDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        if (!allowAccess) {
            return;
        }

        const hasFiles = hasFilesDragged(e.dataTransfer);

        // Only handle native file drags here, let react-dnd handle FILE_ITEM drags
        if (!hasFiles) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        // Only set drag over to false if we're actually leaving the drop zone
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX;
        const y = e.clientY;

        if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
            setIsDragOver(false);
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        if (!allowAccess) {
            e.preventDefault();
            e.stopPropagation();
            setIsDragOver(false);
            return;
        }

        // Check if this is a FILE_ITEM drag from react-dnd
        // If so, let react-dnd handle it instead
        if (!e.dataTransfer.files.length) {
            return; // Let react-dnd handle FILE_ITEM drags
        }

        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        const files = Array.from(e.dataTransfer.files);
        const acceptableFiles = files.filter(isAcceptableFile);

        for (const file of acceptableFiles) {
            const sizeError = validateFileSize(file);
            if (sizeError) {
                model.setError(formatFileSizeError(sizeError));
                return;
            }
            await model.addFile(file);
        }

        if (acceptableFiles.length < files.length) {
            const rejectedCount = files.length - acceptableFiles.length;
            const rejectedFiles = files.filter((f) => !isAcceptableFile(f));
            const fileNames = rejectedFiles.map((f) => f.name).join(", ");
            model.setError(
                `${rejectedCount} file${rejectedCount > 1 ? "s" : ""} rejected (unsupported type): ${fileNames}. Supported: images, PDFs, and text/code files.`
            );
        }
    };

    const handleFileItemDrop = useCallback(
        (draggedFile: DraggedFile) => {
            if (!allowAccess) {
                return;
            }
            model.addFileFromRemoteUri(draggedFile);
        },
        [model, allowAccess]
    );

    const [{ isOver, canDrop }, drop] = useDrop(
        () => ({
            accept: "FILE_ITEM",
            drop: handleFileItemDrop,
            collect: (monitor) => ({
                isOver: monitor.isOver(),
                canDrop: monitor.canDrop(),
            }),
        }),
        [handleFileItemDrop]
    );

    // Update drag over state for FILE_ITEM drags
    useEffect(() => {
        if (isOver && canDrop) {
            setIsReactDndDragOver(true);
        } else {
            setIsReactDndDragOver(false);
        }
    }, [isOver, canDrop]);

    // Attach the drop ref to the container
    useEffect(() => {
        if (containerRef.current) {
            drop(containerRef.current);
        }
    }, [drop]);

    const handleFocusCapture = useCallback(
        (_event: React.FocusEvent) => {
            // console.log("Crowe Logic focus capture", getElemAsStr(event.target));
            model.requestWaveAIFocus();
        },
        [model]
    );

    const handlePointerEnter = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (focusFollowsCursorMode !== "on") return;
            if (event.pointerType === "touch" || event.buttons > 0) return;
            if (isFocused) return;
            model.focusInput();
        },
        [focusFollowsCursorMode, isFocused, model]
    );

    const handleClick = (e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        const isInteractive = target.closest('button, a, input, textarea, select, [role="button"], [tabindex]');

        if (isInteractive) {
            return;
        }

        const hasSelection = waveAIHasSelection();
        if (hasSelection) {
            model.requestWaveAIFocus();
            return;
        }

        setTimeout(() => {
            if (!waveAIHasSelection()) {
                model.focusInput();
            }
        }, 0);
    };

    const showBlockMask = isLayoutMode && showOverlayBlockNums;
    const borderColor = isFocused ? (tabActiveBorderColor ?? null) : (tabBorderColor ?? null);

    return (
        <div
            ref={containerRef}
            data-waveai-panel="true"
            className={cn(
                "@container bg-zinc-900/70 flex flex-col relative",
                model.inBuilder ? "mt-0 h-full" : "mt-1 h-[calc(100%-4px)]",
                (isDragOver || isReactDndDragOver) && "bg-zinc-800 border-accent",
                isFocused && !borderColor ? "border-2 border-accent" : "border-2 border-transparent"
            )}
            style={{
                borderTopLeftRadius: roundTopLeft ? 10 : 0,
                borderTopRightRadius: model.inBuilder ? 0 : 10,
                borderBottomRightRadius: model.inBuilder ? 0 : 10,
                borderBottomLeftRadius: 10,
                borderColor: borderColor ?? undefined,
            }}
            onFocusCapture={handleFocusCapture}
            onPointerEnter={handlePointerEnter}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleClick}
            inert={!isPanelVisible ? true : undefined}
            data-aipanel="true"
        >
            <ConfigChangeModeFixer />
            {(isDragOver || isReactDndDragOver) && allowAccess && <AIDragOverlay />}
            {showBlockMask && <AIBlockMask />}
            <AIPanelHeader />
            <AIRateLimitStrip />

            <div key="main-content" className="flex-1 flex flex-col min-h-0">
                {!allowAccess ? (
                    <TelemetryRequiredMessage />
                ) : (
                    <>
                        {messages.length === 0 && initialLoadDone ? (
                            <div
                                className="flex-1 overflow-y-auto p-2 relative"
                                onContextMenu={(e) => handleWaveAIContextMenu(e, true)}
                            >
                                <div className="absolute top-2 left-2 z-10">
                                    <AIModeDropdown />
                                </div>
                                {model.inBuilder ? <AIBuilderWelcomeMessage /> : <AIWelcomeMessage />}
                            </div>
                        ) : (
                            <AIPanelMessages
                                messages={messages}
                                status={status}
                                onContextMenu={(e) => handleWaveAIContextMenu(e, true)}
                            />
                        )}
                        <AIErrorMessage />
                        <AIDroppedFiles model={model} />
                        <AIPanelInput onSubmit={handleSubmit} status={status} model={model} />
                    </>
                )}
            </div>
        </div>
    );
});

AIPanelComponentInner.displayName = "AIPanelInner";

type AIPanelComponentProps = {
    roundTopLeft: boolean;
};

const AIPanelComponent = ({ roundTopLeft }: AIPanelComponentProps) => {
    return (
        <ErrorBoundary>
            <AIPanelComponentInner roundTopLeft={roundTopLeft} />
        </ErrorBoundary>
    );
};

AIPanelComponent.displayName = "AIPanel";

export { AIPanelComponent as AIPanel };
