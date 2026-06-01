// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { McpUiViewModel } from "./mcpui-model";

export function McpUiView({ model }: ViewComponentProps<McpUiViewModel>) {
    const html = useAtomValue(model.htmlAtom);
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        function handleMessage(e: MessageEvent) {
            if (e.source !== iframeRef.current?.contentWindow) {
                return;
            }
            const data = e.data as { type?: string; payload?: any; messageId?: string };
            if (data == null || data.type == null) {
                return;
            }
            const payload = data.payload ?? {};
            switch (data.type) {
                case "ui-lifecycle-iframe-ready":
                case "ui-size-change":
                    break;
                case "tool":
                    model.sendAction({
                        type: "tool",
                        toolname: payload.toolName,
                        params: payload.params != null ? JSON.stringify(payload.params) : undefined,
                    });
                    break;
                case "prompt":
                    model.sendAction({ type: "prompt", prompt: payload.prompt });
                    break;
                case "link":
                    model.sendAction({ type: "link", url: payload.url });
                    break;
                case "intent":
                    model.sendAction({
                        type: "intent",
                        intent: payload.intent,
                        params: payload.params != null ? JSON.stringify(payload.params) : undefined,
                    });
                    break;
                case "notify":
                    model.sendAction({ type: "notify", message: payload.message });
                    break;
                default:
                    return;
            }
            if (data.messageId != null) {
                iframeRef.current?.contentWindow?.postMessage(
                    { type: "ui-message-received", messageId: data.messageId },
                    "*"
                );
            }
        }

        window.addEventListener("message", handleMessage);
        return () => {
            window.removeEventListener("message", handleMessage);
        };
    }, [model]);

    return (
        <iframe
            ref={iframeRef}
            sandbox="allow-scripts"
            srcDoc={html}
            className={cn("w-full h-full border-0")}
            title="MCP UI"
        />
    );
}
