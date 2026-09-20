// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AIPanelMessages } from "@/app/aipanel/aipanelmessages";
import { WaveUIMessage } from "@/app/aipanel/aitypes";
import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { useLayoutEffect, useState } from "react";

const LongToken = "release_validation_".repeat(16);
const Cases: Record<string, WaveUIMessage[]> = {
    prose: [
        {
            id: "user",
            role: "user",
            parts: [{ type: "text", text: "Keep the response inside this narrow chat pane." }],
        },
        {
            id: "assistant",
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: "The terminal block is already visible in the tab state. This response and the following tool card should wrap inside the available space beside the avatar. ".repeat(
                        4
                    ),
                },
                {
                    type: "data-tooluse",
                    data: {
                        toolcallid: "completed",
                        toolname: "terminal_propose_command",
                        tooldesc: "proposing terminal.propose_command",
                        status: "completed",
                        approval: "user-approved",
                    },
                },
            ],
        },
    ],
    tokens: [
        {
            id: "tokens",
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: `Long path: /workspace/${LongToken}\n\nhttps://example.com/${LongToken}\n\nInline identifier: \`${LongToken}\``,
                },
                {
                    type: "data-tooluse",
                    data: {
                        toolcallid: "error",
                        toolname: "terminal_propose_command",
                        tooldesc: LongToken,
                        status: "error",
                        errormessage: `Missing path: ${LongToken}`,
                    },
                },
                {
                    type: "data-toolprogress",
                    data: { toolcallid: "progress", toolname: "terminal_list_blocks", statuslines: [LongToken] },
                },
            ],
        },
    ],
    code: [
        {
            id: "code",
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: `A long code line must scroll inside the code block.\n\n\`\`\`text\n${LongToken}\n\`\`\``,
                },
            ],
        },
    ],
    table: [
        {
            id: "table",
            role: "assistant",
            parts: [
                {
                    type: "text",
                    text: `| ${Array.from({ length: 12 }, (_, i) => `Column ${i}`).join(" | ")} |\n| ${Array(12).fill("---").join(" | ")} |\n| ${Array(12).fill("Recorded result").join(" | ")} |`,
                },
            ],
        },
    ],
    approval: [
        {
            id: "approval",
            role: "assistant",
            parts: [
                { type: "text", text: "This is a static preview; approval buttons never execute tools." },
                {
                    type: "data-tooluse",
                    data: {
                        toolcallid: "pending",
                        toolname: "terminal_propose_command",
                        tooldesc: "proposing terminal.propose_command",
                        status: "pending",
                        approval: "needs-approval",
                        terminalproposal: {
                            command: "pwd",
                            blockid: "11111111-1111-4111-8111-111111111111",
                            tabid: "22222222-2222-4222-8222-222222222222",
                            connection: "",
                        },
                    },
                },
            ],
        },
    ],
};

export function ChatOverflowPreview() {
    const params = new URLSearchParams(window.location.search);
    const width = Number(params.get("width")) || 450;
    const name = params.get("case") || "prose";
    const model = WaveAIModel.getInstance();
    const [ready, setReady] = useState(false);
    useLayoutEffect(() => {
        const previous = model.toolUseSendApproval;
        const previousVisible = model.panelVisibleAtom;
        const previousWidth = globalStore.get(model.containerWidth);
        model.panelVisibleAtom = atom(true);
        model.toolUseSendApproval = async (toolcallid, decision) => {
            globalStore.set(model.toolApprovalRequests, (requests) => ({
                ...requests,
                [toolcallid]: { status: "submitted", decision },
            }));
        };
        globalStore.set(model.toolApprovalRequests, {});
        globalStore.set(model.containerWidth, width);
        setReady(true);
        return () => {
            model.toolUseSendApproval = previous;
            model.panelVisibleAtom = previousVisible;
            globalStore.set(model.containerWidth, previousWidth);
        };
    }, [model, width]);

    return (
        <div
            data-testid="chat-overflow"
            className="@container flex h-[700px] min-h-0 flex-col border border-border bg-background"
            style={{ width }}
        >
            {ready && (
                <AIPanelMessages
                    messages={Cases[name] ?? Cases.prose}
                    status={name === "approval" ? "streaming" : "ready"}
                />
            )}
        </div>
    );
}
