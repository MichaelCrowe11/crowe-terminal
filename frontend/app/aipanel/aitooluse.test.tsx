// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { WshClient } from "@/app/store/wshclient";
import { RpcApi } from "@/app/store/wshclientapi";
import { setDefaultRouter } from "@/app/store/wshrpcutil-base";
import { PrimitiveAtom, Provider, atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIToolUseGroup, hasValidTerminalProposal, summarizeStep } from "./aitooluse";
import { WaveUIMessagePart } from "./aitypes";
import { WaveAIModel } from "./waveai-model";

const BlockId = "11111111-1111-4111-8111-111111111111";
const TabId = "22222222-2222-4222-8222-222222222222";
type ToolPart = WaveUIMessagePart & { type: "data-tooluse" };

function makePart(callid = "call-a", command = "pwd"): ToolPart {
    return {
        type: "data-tooluse",
        data: {
            toolcallid: callid,
            toolname: "terminal_propose_command",
            tooldesc: "Proposed command",
            status: "pending",
            approval: "needs-approval",
            terminalproposal: { command, blockid: BlockId, tabid: TabId, connection: "" },
        },
    };
}

function renderCards(parts: ToolPart[], isStreaming = true): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <AIToolUseGroup parts={parts} isStreaming={isStreaming} />
        </Provider>
    );
}

let model: WaveAIModel;
beforeEach(() => {
    vi.restoreAllMocks();
    model = Object.create(WaveAIModel.prototype);
    model.toolApprovalRequests = atom({});
    model.restoreBackupModalToolCallId = atom(null) as PrimitiveAtom<string>;
    vi.spyOn(WaveAIModel, "getInstance").mockReturnValue(model);
    vi.spyOn(RpcApi, "WaveAIToolApproveCommand").mockRejectedValue(new Error("Unexpected RPC"));
});

describe("terminal proposal preview", () => {
    it("preserves exact selectable plaintext, whitespace and canonical destination", () => {
        const command = "  printf '<script> **hello** 😀'  ";
        const markup = renderCards([makePart("call-a", command)]);
        expect(markup).toContain("  printf &#x27;&lt;script&gt; **hello** 😀&#x27;  ");
        expect(markup).not.toContain("<script>");
        expect(markup).toContain("whitespace-pre");
        expect(markup).toContain("select-text");
        expect(markup).toContain(BlockId);
        expect(markup).toContain(TabId);
        expect(markup).toContain("Local");
        expect(markup).toContain("Approve typing");
        expect(markup).toContain("Enter is a separate terminal action");
        expect(markup).toContain('data-toolcallid="call-a"');
        expect(RpcApi.WaveAIToolApproveCommand).not.toHaveBeenCalled();
    });

    it.each([0, 9, 10, 13, 27, 31, 127, 128, 159, 0x2028, 0x2029, 0xd800, 0xdfff])(
        "rejects control or malformed scalar U+%s without approving it",
        (codepoint) => {
            const part = makePart("call-a", `pwd${String.fromCharCode(codepoint)}`);
            expect(hasValidTerminalProposal(part)).toBe(false);
            const markup = renderCards([part]);
            expect(markup).toMatch(/<button disabled=""[^>]*>Approve typing<\/button>/);
            expect(markup).toMatch(/<button(?! disabled)[^>]*>Deny<\/button>/);
            expect(markup).not.toContain('data-testid="terminal-command"');
        }
    );

    it.each([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])(
        "rejects Bidi_Control U+%s in command and connection",
        (codepoint) => {
            for (const field of ["command", "connection"] as const) {
                const part = makePart();
                part.data.terminalproposal[field] = `text${String.fromCodePoint(codepoint)}text`;
                expect(hasValidTerminalProposal(part)).toBe(false);
                expect(renderCards([part])).toMatch(/<button disabled=""[^>]*>Approve typing<\/button>/);
            }
        }
    );

    it("preserves ordinary Unicode in commands and destinations", () => {
        const part = makePart("unicode", "printf 'العربية עברית 中文 é 😀'");
        part.data.terminalproposal.connection = "用户@主机";
        expect(hasValidTerminalProposal(part)).toBe(true);
        expect(renderCards([part])).toContain("用户@主机");
    });

    it.each(["missing", "prefix", "tab", "mismatch", "connection", "empty"])(
        "fails closed on %s preview while retaining denial",
        (kind) => {
            const part = makePart();
            if (kind === "missing") delete part.data.terminalproposal;
            if (kind === "prefix") part.data.terminalproposal.blockid = BlockId.slice(0, 8);
            if (kind === "tab") part.data.terminalproposal.tabid = "not-a-tab";
            if (kind === "mismatch") part.data.blockid = TabId;
            if (kind === "connection") part.data.terminalproposal.connection = "remote\nother";
            if (kind === "empty") part.data.terminalproposal.command = "   ";
            expect(hasValidTerminalProposal(part)).toBe(false);
            const markup = renderCards([part]);
            expect(markup).toContain("Command preview missing or invalid");
            expect(markup).toMatch(/<button disabled=""[^>]*>Approve typing<\/button>/);
            expect(markup).toMatch(/<button(?! disabled)[^>]*>Deny<\/button>/);
        }
    );

    it("never revives historical, denied, or failed calls as actionable", () => {
        expect(renderCards([makePart()], false)).not.toContain("Approve typing");
        const denied = makePart();
        denied.data.approval = "user-denied";
        globalStore.set(model.toolApprovalRequests, {
            "call-a": { status: "error", decision: "user-approved", error: "old" },
        });
        expect(renderCards([denied])).not.toContain("Approve typing");
        const failed = makePart();
        failed.data.status = "error";
        expect(renderCards([failed])).not.toContain("Approve typing");
    });

    it("keeps generic terminal execution approvals unchanged", () => {
        const part = makePart();
        part.data.toolname = "terminal_exec_safe";
        delete part.data.terminalproposal;
        expect(renderCards([part])).toMatch(/>Approve<\/button>/);
        expect(renderCards([part])).not.toContain("preview missing");
    });
});

describe("per-call approval requests", () => {
    it("awaits RPC and blocks repeated or opposite clicks until the server responds", async () => {
        let resolve: () => void;
        const rpc = vi.mocked(RpcApi.WaveAIToolApproveCommand).mockImplementation(
            () =>
                new Promise<void>((done) => {
                    resolve = done;
                })
        );
        const pending = model.toolUseSendApproval("call-a", "user-approved");
        expect(globalStore.get(model.toolApprovalRequests)["call-a"].status).toBe("pending");
        expect(renderCards([makePart()])).toMatch(/<button disabled=""[^>]*>Approve typing<\/button>/);
        await model.toolUseSendApproval("call-a", "user-denied");
        expect(rpc).toHaveBeenCalledTimes(1);
        resolve();
        await pending;
        expect(globalStore.get(model.toolApprovalRequests)["call-a"].status).toBe("submitted");
        expect(renderCards([makePart()])).toContain("Decision received. Waiting for tool status.");
        expect(renderCards([makePart()])).not.toContain("Text typed;");
        await model.toolUseSendApproval("call-a", "user-approved");
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it("shows failures without false success and permits a deliberate retry", async () => {
        const rpc = vi
            .mocked(RpcApi.WaveAIToolApproveCommand)
            .mockRejectedValueOnce(new Error("transport unavailable"))
            .mockResolvedValue(undefined);
        await expect(model.toolUseSendApproval("call-a", "user-approved")).rejects.toThrow("transport unavailable");
        const markup = renderCards([makePart()]);
        expect(markup).toContain('role="alert"');
        expect(markup).toContain("transport unavailable");
        expect(markup).toMatch(/<button(?! disabled)[^>]*>Approve typing<\/button>/);
        expect(markup).not.toContain("Decision received");
        await model.toolUseSendApproval("call-a", "user-denied");
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(globalStore.get(model.toolApprovalRequests)["call-a"].decision).toBe("user-denied");
    });

    it("keeps state attached to the call across reorder, replacement and current-payload changes", async () => {
        vi.mocked(RpcApi.WaveAIToolApproveCommand).mockResolvedValue(undefined);
        await model.toolUseSendApproval("call-a", "user-approved");
        const a = makePart("call-a");
        const b = makePart("call-b", "echo second");
        for (const parts of [[a, b], [b, a], [b]]) {
            const markup = renderCards(parts);
            expect(markup.match(/>Approve typing<\/button>/g)).toHaveLength(1);
            expect(markup).toContain("echo second");
        }
        a.data.terminalproposal.command = "echo current";
        expect(renderCards([a])).toContain("echo current");
        a.data.approval = "user-denied";
        expect(renderCards([a])).not.toContain("Decision received");
    });

    it("does not let a late reply repopulate cleared chat state", async () => {
        let resolve: () => void;
        vi.mocked(RpcApi.WaveAIToolApproveCommand).mockImplementation(
            () =>
                new Promise<void>((done) => {
                    resolve = done;
                })
        );
        const pending = model.toolUseSendApproval("call-a", "user-approved");
        globalStore.set(model.toolApprovalRequests, {});
        resolve();
        await pending;
        expect(globalStore.get(model.toolApprovalRequests)).toEqual({});
    });

    it("times out a lost request through the real RPC client without retrying or accepting a late reply", async () => {
        vi.useFakeTimers();
        const client = new WshClient("approval-test");
        const sent: RpcMessage[] = [];
        setDefaultRouter({ recvRpcMessage: (message: RpcMessage) => sent.push(message) } as any);
        const rpc = vi
            .mocked(RpcApi.WaveAIToolApproveCommand)
            .mockImplementation((_client, data, opts) => client.wshRpcCall("waveaitoolapprove", data, opts));
        try {
            const pending = model.toolUseSendApproval("call-a", "user-approved");
            const rejected = expect(pending).rejects.toThrow("EC-TIME");
            expect(sent[0].timeout).toBe(10000);
            await vi.advanceTimersByTimeAsync(10000);
            await rejected;
            expect(client.openRpcs.size).toBe(0);
            expect(globalStore.get(model.toolApprovalRequests)["call-a"].status).toBe("error");
            expect(renderCards([makePart()])).toContain("It may already have been received");
            expect(renderCards([makePart()])).toContain("No automatic retry was sent");
            const stopped = renderCards([makePart()], false);
            expect(stopped).toContain("Decision delivery and tool outcome unconfirmed");
            expect(stopped).not.toContain("Not approved");
            expect(stopped).not.toContain("<button");
            vi.spyOn(console, "log").mockImplementation(() => {});
            client.recvRpcMessage({ resid: sent[0].reqid });
            await vi.advanceTimersByTimeAsync(20000);
            expect(globalStore.get(model.toolApprovalRequests)["call-a"].status).toBe("error");
            expect(rpc).toHaveBeenCalledTimes(1);
            globalStore.set(model.toolApprovalRequests, {});
            client.recvRpcMessage({ resid: sent[0].reqid });
            expect(globalStore.get(model.toolApprovalRequests)).toEqual({});
        } finally {
            setDefaultRouter(null);
            vi.useRealTimers();
        }
    });

    it.each(["terminal_propose_command", "read_text_file"])(
        "keeps an acknowledged %s decision unconfirmed after streaming stops until authoritative status arrives",
        async (toolname) => {
            vi.mocked(RpcApi.WaveAIToolApproveCommand).mockResolvedValue(undefined);
            await model.toolUseSendApproval("call-a", "user-approved");
            const part = makePart();
            part.data.toolname = toolname;
            const markup = renderCards([part], false);
            expect(markup).toContain("Decision received. Tool outcome unconfirmed");
            expect(markup).not.toContain("Not approved");
            expect(markup).not.toContain("<button");
            part.data.approval = "timeout";
            expect(renderCards([part], false)).toContain("Not approved");
            expect(renderCards([part], false)).not.toContain("outcome unconfirmed");
            part.data.approval = "user-approved";
            part.data.status = "completed";
            expect(renderCards([part], false)).not.toContain("outcome unconfirmed");
        }
    );

    it("uses stable batch categories when another member leaves or joins", () => {
        const a = makePart("call-a");
        const b = makePart("call-b");
        a.data.toolname = b.data.toolname = "read_text_file";
        const group = (AIToolUseGroup as any).type;
        const keys = (parts: ToolPart[]) =>
            group({ parts, isStreaming: true }).props.children.map((child: any) => child.key);
        expect(keys([a, b])).toEqual(["batch:needs-approval"]);
        expect(keys([b])).toEqual(["batch:needs-approval"]);
        a.data.approval = "user-approved";
        expect(keys([a, b])).toEqual(["batch:other", "batch:needs-approval"]);
        expect(keys([b, a])).toEqual(["batch:needs-approval", "batch:other"]);
    });

    it("rejects malformed decision requests without calling RPC", async () => {
        await expect(model.toolUseSendApproval("", "user-approved")).rejects.toThrow("Invalid approval request");
        await expect(model.toolUseSendApproval("call-a", "auto-approved" as any)).rejects.toThrow(
            "Invalid approval request"
        );
        expect(RpcApi.WaveAIToolApproveCommand).not.toHaveBeenCalled();
    });
});

describe("step summaries", () => {
    it("names the file or directory the backend described", () => {
        expect(summarizeStep("read_text_file", 'reading "vite.config.ts" (entire file)', "completed")).toBe(
            "Read vite.config.ts"
        );
        expect(summarizeStep("read_text_file", 'reading "a.ts" (first 40 lines)', "pending")).toBe("Reading a.ts");
        expect(summarizeStep("read_dir", 'reading directory "src" (entire directory)', "error")).toBe(
            "Couldn't open src"
        );
        expect(summarizeStep("edit_text_file", 'editing "x.go" (2 edits)', "completed")).toBe("Edited x.go");
    });

    it("falls back to the generic label when there is no phrase or no target", () => {
        expect(summarizeStep("read_text_file", "", "completed")).toBe("Read a file");
        expect(summarizeStep("browser.open_tab", "", "completed")).toBe("Browser: Open tab");
        expect(summarizeStep("vcs_diff", "", "error")).toBe("Read the diff (failed)");
    });

    it("hides raw tool ids behind details and keeps the plain summary visible", () => {
        const part = makePart("call-read");
        part.data.toolname = "term_command_output";
        part.data.tooldesc = "reading last command output from 11111111";
        part.data.status = "completed";
        part.data.approval = "auto-approved";
        const markup = renderCards([part]);
        expect(markup).toContain("Read the last command&#x27;s output");
        expect(markup).toMatch(/<details[^>]*>[\s\S]*term_command_output/);
    });
});
