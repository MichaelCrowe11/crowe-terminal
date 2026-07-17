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
import { TelemetryModel } from "@/app/dock/telemetry-model";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import * as jotai from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useDrop } from "react-dnd";
import { formatFileSizeError, isAcceptableFile, validateFileSize } from "./ai-utils";
import { AIDroppedFiles } from "./aidroppedfiles";
import { AIPanelHeader } from "./aipanelheader";
import { AIPanelInput } from "./aipanelinput";
import { AIPanelMessages } from "./aipanelmessages";
import { AIRateLimitStrip } from "./airatelimitstrip";
import { WaveUIMessage } from "./aitypes";
import { CroweChannelPanel } from "./crowechannelpanel";
import { WaveAIModel } from "./waveai-model";
import croweMark from "@/app/asset/hypheus-mark.png";
import "./aipanel.scss";

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
            className="absolute inset-0 bg-accent/20 border-2 border-dashed border-accent rounded-[2px] flex items-center justify-center z-10 p-4"
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

const AIWelcomeMessage = memo(() => {
    const modKey = isMacOS() ? "⌘" : "Alt";
    const focusKeys = isWindows() ? "Alt 0" : "Ctrl Shift 0";
    const model = WaveAIModel.getInstance();
    const widgetAccess = jotai.useAtomValue(model.widgetAccessAtom);

    return (
        <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
            <div className="flex flex-col items-center gap-3 text-center">
                <img
                    src={croweMark}
                    alt=""
                    className="h-12 w-12 rounded-[var(--radius-md)] border border-[var(--crowe-gold-30)] object-contain shadow-[0_0_24px_-6px_var(--glow-gold)]"
                />
                <div>
                    <div
                        className="text-[22px] leading-none text-[var(--text)]"
                        style={{ fontFamily: "var(--font-serif)" }}
                    >
                        Hypheus
                    </div>
                    <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--crowe-gold-65)]">
                        Crowe Logic operator
                    </div>
                </div>
                <p className="text-[13px] leading-relaxed text-[var(--text-dim)]">
                    One operator for terminal, code, research, and grow ops. It reads your workspace, uses your
                    tools, and moves the work forward.
                </p>
                <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span
                        className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            widgetAccess
                                ? "bg-[var(--accent)] shadow-[0_0_6px_var(--glow-gold)]"
                                : "bg-[var(--text-dim)]"
                        )}
                    />
                    <span className={widgetAccess ? "text-[var(--text)]" : "text-[var(--text-dim)]"}>
                        ready · {widgetAccess ? "tools on" : "sandboxed"}
                    </span>
                </div>
            </div>

            <CroweChannelPanel />

            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--crowe-parchment-40)]">
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
        <div className="px-4 py-8 max-w-md mx-auto">
            <div className="flex items-center gap-3 mb-4">
                <img
                    src={croweMark}
                    alt=""
                    className="h-10 w-10 rounded-[var(--radius-sm)] object-contain ring-1 ring-[var(--crowe-gold-30)]"
                />
                <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--crowe-gold-65)]">
                        crowe logic
                    </div>
                    <div className="font-semibold text-[var(--text)] text-[15px] -mt-0.5">app builder</div>
                </div>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--text-dim)]">
                Build custom widgets that integrate directly into Hypheus. Describe the widget you want and Hypheus will scaffold it.
            </p>
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
        <div className="px-4 py-2 text-[var(--crowe-error)] bg-[var(--crowe-error-15)] border-l-4 border-[var(--crowe-error)] mx-2 mb-2 relative">
            <button
                onClick={() => model.clearError()}
                className="absolute top-2 right-2 text-[var(--crowe-error)] hover:brightness-110 cursor-pointer z-10"
                aria-label="Close error"
            >
                <i className="fa fa-times text-sm"></i>
            </button>
            <div className="text-sm pr-6 max-h-[100px] overflow-y-auto">
                {errorMessage}
                <button
                    onClick={() => model.clearChat()}
                    className="ml-2 text-xs text-[var(--crowe-error)] hover:brightness-110 cursor-pointer underline"
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
    const aiModeConfigs = jotai.useAtomValue(model.aiModeConfigs);

    useEffect(() => {
        model.fixModeAfterConfigChange();
    }, [aiModeConfigs, model]);

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
    const isPanelVisible = jotai.useAtomValue(model.getPanelVisibleAtom());
    const tabModel = useTabModelMaybe();
    const [tabBorderColor, tabActiveBorderColor] = useTabBackground(waveEnv, tabModel?.tabId);
    const allowAccess = true;

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
        TelemetryModel.getInstance().connect();
    }, []);

    // Drive the dock telemetry panel: mark run boundaries off the chat status.
    useEffect(() => {
        const telemetry = TelemetryModel.getInstance();
        if (status === "submitted") {
            telemetry.onSubmit();
        } else if (status === "ready") {
            telemetry.finish(false);
        } else if (status === "error") {
            telemetry.finish(true);
        }
    }, [status]);

    // Feed streamed character count to telemetry so TTFT / tok/s reflect the real
    // stream (tokens are estimated from chars; the panel labels them as such).
    useEffect(() => {
        if (status !== "streaming" && status !== "submitted") {
            return;
        }
        const last = messages[messages.length - 1];
        if (last?.role !== "assistant") {
            return;
        }
        let chars = 0;
        for (const part of last.parts ?? []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                chars += (part as any).text.length;
            }
        }
        TelemetryModel.getInstance().recordChars(chars);
    }, [messages, status]);

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
                "@container bg-[var(--surface)] flex flex-col relative",
                model.inBuilder ? "mt-0 h-full" : "mt-1 h-[calc(100%-4px)]",
                (isDragOver || isReactDndDragOver) && "bg-[var(--surface-raised-hover)] border-[var(--accent)]",
                isFocused && !borderColor ? "border-2 border-accent" : "border-2 border-transparent"
            )}
            style={{
                borderTopLeftRadius: roundTopLeft ? 2 : 0,
                borderTopRightRadius: model.inBuilder ? 0 : 2,
                borderBottomRightRadius: model.inBuilder ? 0 : 2,
                borderBottomLeftRadius: 2,
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
                {messages.length === 0 && initialLoadDone ? (
                    <div
                        className="crowe-scroll-thin relative flex-1 overflow-y-auto p-2"
                        onContextMenu={(e) => handleWaveAIContextMenu(e, true)}
                    >
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
