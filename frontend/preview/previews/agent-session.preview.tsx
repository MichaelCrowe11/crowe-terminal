// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AIPanelMessages } from "@/app/aipanel/aipanelmessages";
import { WaveUIMessage } from "@/app/aipanel/aitypes";
import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { useLayoutEffect, useState } from "react";

const TermBlockId = "11111111-1111-4111-8111-111111111111";
const TabId = "22222222-2222-4222-8222-222222222222";

// Descriptions below are the exact strings the backend ToolCallDesc funcs emit
// (pkg/aiusechat/tools_*.go), so the preview shows what users actually read.
const Session: WaveUIMessage[] = [
    {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Why is the dev server failing to start? Fix it if you can." }],
    },
    {
        id: "a1",
        role: "assistant",
        parts: [
            { type: "text", text: "I'll check the terminal output and the Vite config first." },
            {
                type: "data-tooluse",
                data: {
                    toolcallid: "t1",
                    toolname: "term_command_output",
                    tooldesc: `reading last command output from ${TermBlockId.slice(0, 8)}`,
                    status: "completed",
                    approval: "auto-approved",
                    blockid: TermBlockId,
                },
            },
            {
                type: "data-tooluse",
                data: {
                    toolcallid: "t2",
                    toolname: "read_text_file",
                    tooldesc: `reading "vite.config.ts" (entire file)`,
                    status: "completed",
                    approval: "user-approved",
                },
            },
            {
                type: "data-tooluse",
                data: {
                    toolcallid: "t3",
                    toolname: "read_text_file",
                    tooldesc: `reading "package.json" (first 40 lines)`,
                    status: "completed",
                    approval: "user-approved",
                },
            },
            {
                type: "data-tooluse",
                data: {
                    toolcallid: "t4",
                    toolname: "read_dir",
                    tooldesc: `reading directory "src/plugins" (entire directory)`,
                    status: "error",
                    errormessage: "open src/plugins: no such file or directory",
                },
            },
            {
                type: "text",
                text: "Port **5173** is already taken by an older dev server, so Vite exits. `vite.config.ts` sets `strictPort: true`, which is why it does not fall back to another port.",
            },
            {
                type: "data-tooluse",
                data: {
                    toolcallid: "t5",
                    toolname: "edit_text_file",
                    tooldesc: `editing "vite.config.ts" (1 edit)`,
                    status: "completed",
                    approval: "user-approved",
                    inputfilename: "vite.config.ts",
                },
            },
            {
                type: "data-tooluse",
                data: {
                    toolcallid: "t6",
                    toolname: "terminal_propose_command",
                    tooldesc: "proposing terminal.propose_command",
                    status: "pending",
                    approval: "needs-approval",
                    blockid: TermBlockId,
                    terminalproposal: {
                        command: "lsof -ti :5173 | xargs kill && npm run dev",
                        blockid: TermBlockId,
                        tabid: TabId,
                        connection: "",
                    },
                },
            },
        ],
    },
];

export function AgentSessionPreview() {
    const params = new URLSearchParams(window.location.search);
    const width = Number(params.get("width")) || 440;
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
            data-testid="agent-session"
            className="@container flex h-[1000px] min-h-0 flex-col border border-border bg-background"
            style={{ width }}
        >
            {ready && <AIPanelMessages messages={Session} status="streaming" />}
        </div>
    );
}
