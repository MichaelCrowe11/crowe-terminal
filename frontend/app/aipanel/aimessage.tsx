// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WaveStreamdown } from "@/app/element/streamdown";
import { cn } from "@/util/util";
import { memo, useEffect, useRef, useState } from "react";
import { getFileIcon } from "./ai-utils";
import { AIFeedbackButtons } from "./aifeedbackbuttons";
import { AIToolUseGroup } from "./aitooluse";
import { WaveUIMessage, WaveUIMessagePart } from "./aitypes";
import { WaveAIModel } from "./waveai-model";
import croweMark from "@/app/asset/hypheus-mark.png";

// Mycelium cognition verbs, shared vocabulary with the dock Cognition panel.
const CognitionVerbs = ["Germinating", "Branching", "Colonizing", "Synthesizing", "Reasoning", "Cultivating"];

const AIThinking = memo(
    ({
        message = "Thinking",
        reasoningText,
        isWaitingApproval = false,
    }: {
        message?: string;
        reasoningText?: string;
        isWaitingApproval?: boolean;
    }) => {
        const scrollRef = useRef<HTMLDivElement>(null);
        const [verbIdx, setVerbIdx] = useState(0);
        // Cycle the cognition verb only while actively working (no reasoning
        // trace to show and nothing pending approval).
        const cycleVerb = !isWaitingApproval && !reasoningText;

        useEffect(() => {
            if (scrollRef.current && reasoningText) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
        }, [reasoningText]);

        useEffect(() => {
            if (!cycleVerb) {
                return;
            }
            const id = setInterval(() => setVerbIdx((i) => (i + 1) % CognitionVerbs.length), 1600);
            return () => clearInterval(id);
        }, [cycleVerb]);

        const displayText = reasoningText
            ? (() => {
                  const lastDoubleNewline = reasoningText.lastIndexOf("\n\n");
                  return lastDoubleNewline !== -1 ? reasoningText.substring(lastDoubleNewline + 2) : reasoningText;
              })()
            : "";

        const label = isWaitingApproval
            ? message || "Waiting for approvals"
            : reasoningText
              ? "Reasoning"
              : CognitionVerbs[verbIdx];

        return (
            <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                    {isWaitingApproval ? (
                        <i className="fa fa-clock text-[13px] text-[var(--syntax-warn)]"></i>
                    ) : (
                        <span
                            aria-hidden="true"
                            className="inline-block h-[13px] w-[2px] animate-pulse rounded-[1px] bg-[var(--accent)] shadow-[0_0_6px_var(--glow-gold)]"
                        />
                    )}
                    <span
                        key={label}
                        className="crowe-cognition-verb font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--text-dim)]"
                    >
                        {label}
                    </span>
                </div>
                {displayText && (
                    <div
                        ref={scrollRef}
                        className="crowe-scroll-thin ml-[3px] h-[3lh] max-w-[600px] overflow-y-auto border-l border-[var(--hairline-faint)] pl-4 text-[12px] leading-relaxed text-[var(--crowe-parchment-45)]"
                    >
                        {displayText}
                    </div>
                )}
            </div>
        );
    }
);

AIThinking.displayName = "AIThinking";

interface UserMessageFilesProps {
    fileParts: Array<WaveUIMessagePart & { type: "data-userfile" }>;
}

const UserMessageFiles = memo(({ fileParts }: UserMessageFilesProps) => {
    if (fileParts.length === 0) return null;

    return (
        <div className="mt-2 border-t border-[var(--hairline-faint)] pt-2">
            <div className="flex gap-2 overflow-x-auto pb-1">
                {fileParts.map((file, index) => (
                    <div
                        key={index}
                        className="relative min-w-20 flex-shrink-0 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--surface-raised)] p-2"
                    >
                        <div className="flex flex-col items-center text-center">
                            <div className="mb-1 flex h-12 w-12 items-center justify-center overflow-hidden rounded-[var(--radius-xs)] bg-[var(--surface-sunken)]">
                                {file.data?.previewurl ? (
                                    <img
                                        src={file.data.previewurl}
                                        alt={file.data?.filename || "File"}
                                        className="h-full w-full object-cover"
                                    />
                                ) : (
                                    <i
                                        className={cn(
                                            "fa text-lg text-[var(--text-dim)]",
                                            getFileIcon(file.data?.filename || "", file.data?.mimetype || "")
                                        )}
                                    ></i>
                                )}
                            </div>
                            <div
                                className="w-full max-w-16 truncate text-[10px] text-[var(--text)]"
                                title={file.data?.filename || "File"}
                            >
                                {file.data?.filename || "File"}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
});

UserMessageFiles.displayName = "UserMessageFiles";

interface AIMessagePartProps {
    part: WaveUIMessagePart;
    role: string;
    isStreaming: boolean;
}

const AIMessagePart = memo(({ part, role, isStreaming }: AIMessagePartProps) => {
    const model = WaveAIModel.getInstance();

    if (part.type === "text") {
        const content = part.text ?? "";

        if (role === "user") {
            return <div className="whitespace-pre-wrap break-words">{content}</div>;
        } else {
            return (
                <WaveStreamdown
                    text={content}
                    parseIncompleteMarkdown={isStreaming}
                    className="text-[var(--text)]"
                    codeBlockMaxWidthAtom={model.codeBlockMaxWidth}
                />
            );
        }
    }

    return null;
});

AIMessagePart.displayName = "AIMessagePart";

interface AIMessageProps {
    message: WaveUIMessage;
    isStreaming: boolean;
}

const isDisplayPart = (part: WaveUIMessagePart): boolean => {
    return (
        part.type === "text" ||
        part.type === "data-tooluse" ||
        part.type === "data-toolprogress" ||
        (part.type.startsWith("tool-") && "state" in part && part.state === "input-available")
    );
};

type MessagePart =
    | { type: "single"; part: WaveUIMessagePart }
    | { type: "toolgroup"; parts: Array<WaveUIMessagePart & { type: "data-tooluse" | "data-toolprogress" }> };

const groupMessageParts = (parts: WaveUIMessagePart[]): MessagePart[] => {
    const grouped: MessagePart[] = [];
    let currentToolGroup: Array<WaveUIMessagePart & { type: "data-tooluse" | "data-toolprogress" }> = [];

    for (const part of parts) {
        if (part.type === "data-tooluse" || part.type === "data-toolprogress") {
            currentToolGroup.push(part as WaveUIMessagePart & { type: "data-tooluse" | "data-toolprogress" });
        } else {
            if (currentToolGroup.length > 0) {
                grouped.push({ type: "toolgroup", parts: currentToolGroup });
                currentToolGroup = [];
            }
            grouped.push({ type: "single", part });
        }
    }

    if (currentToolGroup.length > 0) {
        grouped.push({ type: "toolgroup", parts: currentToolGroup });
    }

    return grouped;
};

const getThinkingMessage = (
    parts: WaveUIMessagePart[],
    isStreaming: boolean,
    role: string
): { message: string; reasoningText?: string; isWaitingApproval?: boolean } | null => {
    if (!isStreaming || role !== "assistant") {
        return null;
    }

    const hasPendingApprovals = parts.some(
        (part) => part.type === "data-tooluse" && part.data?.approval === "needs-approval"
    );

    if (hasPendingApprovals) {
        return { message: "Waiting for Tool Approvals...", isWaitingApproval: true };
    }

    const lastPart = parts[parts.length - 1];

    if (lastPart?.type === "reasoning") {
        const reasoningContent = lastPart.text || "";
        return { message: "Reasoning", reasoningText: reasoningContent };
    }

    if (lastPart?.type === "text" && lastPart.text) {
        return null;
    }

    return { message: "" };
};

export const AIMessage = memo(({ message, isStreaming }: AIMessageProps) => {
    const parts = message.parts || [];
    const displayParts = parts.filter(isDisplayPart);
    const fileParts = parts.filter(
        (part): part is WaveUIMessagePart & { type: "data-userfile" } => part.type === "data-userfile"
    );

    const thinkingData = getThinkingMessage(parts, isStreaming, message.role);
    const groupedParts = groupMessageParts(displayParts);

    return (
        <div
            className={cn(
                "crowe-msg-enter flex items-start gap-2.5",
                message.role === "user" ? "justify-end" : "justify-start"
            )}
        >
            {message.role === "assistant" && (
                <div className="mt-0.5 h-7 w-7 flex-shrink-0 overflow-hidden rounded-full border border-[var(--crowe-gold-30)] bg-[var(--surface-sunken)] [box-shadow:inset_0_1px_0_var(--hair-top)]">
                    <img src={croweMark} alt="Hypheus" className="h-full w-full object-contain p-0.5" />
                </div>
            )}
            <div
                className={cn(
                    "[&>*:first-child]:!mt-0",
                    message.role === "user"
                        ? "max-w-[calc(100%-40px)] rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--wash-accent-faint)] px-3.5 py-2.5 text-[var(--text)] [box-shadow:inset_0_1px_0_var(--hair-top)]"
                        : "min-w-[min(100%,500px)] px-1"
                )}
            >
                {displayParts.length === 0 && !isStreaming && !thinkingData ? (
                    <div className="whitespace-pre-wrap break-words">(no text content)</div>
                ) : (
                    <>
                        {groupedParts.map((group, index: number) =>
                            group.type === "toolgroup" ? (
                                <AIToolUseGroup key={index} parts={group.parts} isStreaming={isStreaming} />
                            ) : (
                                <div key={index} className="mt-2">
                                    <AIMessagePart part={group.part} role={message.role} isStreaming={isStreaming} />
                                </div>
                            )
                        )}
                        {thinkingData != null && (
                            <div className="mt-2">
                                <AIThinking
                                    message={thinkingData.message}
                                    reasoningText={thinkingData.reasoningText}
                                    isWaitingApproval={thinkingData.isWaitingApproval}
                                />
                            </div>
                        )}
                    </>
                )}

                {message.role === "user" && <UserMessageFiles fileParts={fileParts} />}
                {message.role === "assistant" && !isStreaming && displayParts.length > 0 && (
                    <AIFeedbackButtons
                        messageText={parts
                            .filter((p) => p.type === "text")
                            .map((p) => p.text || "")
                            .join("\n\n")}
                    />
                )}
            </div>
        </div>
    );
});

AIMessage.displayName = "AIMessage";
