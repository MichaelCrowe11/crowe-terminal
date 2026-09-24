// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useAtomValue } from "jotai";
import { memo, useEffect, useRef, useState } from "react";
import { AIMessage } from "./aimessage";
import { type WaveUIMessage } from "./aitypes";
import { WaveAIModel } from "./waveai-model";

interface AIPanelMessagesProps {
    messages: WaveUIMessage[];
    status: string;
    onContextMenu?: (e: React.MouseEvent) => void;
    footer?: React.ReactNode;
}

export const AIPanelMessages = memo(({ messages, status, onContextMenu, footer }: AIPanelMessagesProps) => {
    const model = WaveAIModel.getInstance();
    const isPanelOpen = useAtomValue(model.getPanelVisibleAtom());
    const widgetAccess = useAtomValue(model.widgetAccessAtom);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const prevStatusRef = useRef<string>(status);
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

    const checkIfAtBottom = () => {
        const container = messagesContainerRef.current;
        if (!container) return true;

        const threshold = 50;
        const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        return scrollBottom <= threshold;
    };

    const handleScroll = () => {
        const atBottom = checkIfAtBottom();
        setShouldAutoScroll(atBottom);
    };

    const scrollToBottom = () => {
        const container = messagesContainerRef.current;
        if (container) {
            container.scrollTop = container.scrollHeight;
            container.scrollLeft = 0;
            setShouldAutoScroll(true);
        }
    };

    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container) return;

        container.addEventListener("scroll", handleScroll);
        return () => container.removeEventListener("scroll", handleScroll);
    }, []);

    useEffect(() => {
        model.registerScrollToBottom(scrollToBottom);
    }, [model]);

    useEffect(() => {
        if (shouldAutoScroll) {
            scrollToBottom();
        }
    }, [messages, shouldAutoScroll]);

    useEffect(() => {
        if (isPanelOpen) {
            scrollToBottom();
        }
    }, [isPanelOpen]);

    useEffect(() => {
        const wasStreaming = prevStatusRef.current === "streaming";
        const isNowNotStreaming = status !== "streaming";

        if (wasStreaming && isNowNotStreaming) {
            requestAnimationFrame(() => {
                scrollToBottom();
            });
        }

        prevStatusRef.current = status;
    }, [status]);

    return (
        <div
            ref={messagesContainerRef}
            className="crowe-operator-main crowe-scroll-thin flex-1 min-h-0 space-y-4 overflow-y-auto p-2"
            onContextMenu={onContextMenu}
        >
            <div className="mb-1 border-b border-[var(--hairline-faint)] px-1 pb-2 text-center text-[11px] text-[var(--text-dim)]">
                {widgetAccess
                    ? "Hypheus can read your terminal and files. It asks before changing files or typing in the terminal."
                    : "Chat only. Hypheus can't see your terminal or files."}
            </div>
            {messages.map((message, index) => {
                const isLastMessage = index === messages.length - 1;
                const isStreaming = status === "streaming" && isLastMessage && message.role === "assistant";
                return <AIMessage key={message.id} message={message} isStreaming={isStreaming} />;
            })}

            {status === "streaming" &&
                (messages.length === 0 || messages[messages.length - 1].role !== "assistant") && (
                    <AIMessage
                        key="last-message"
                        message={{ role: "assistant", parts: [], id: "last-message" } as any}
                        isStreaming={true}
                    />
                )}

            {footer}
            <div ref={messagesEndRef} />
        </div>
    );
});

AIPanelMessages.displayName = "AIPanelMessages";
