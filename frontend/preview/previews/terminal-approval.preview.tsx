// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AIPanel } from "@/app/aipanel/aipanel";
import { WaveUIMessage, WaveUIMessagePart } from "@/app/aipanel/aitypes";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { isPreviewWindow } from "@/app/store/windowtype";
import * as WOS from "@/app/store/wos";
import { WshClient } from "@/app/store/wshclient";
import { RpcApi } from "@/app/store/wshclientapi";
import { DefaultRouter, setDefaultRouter } from "@/app/store/wshrpcutil-base";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { useLayoutEffect, useState } from "react";
import { PreviewTabId, PreviewWindowId, PreviewWorkspaceId } from "../mock/mockwaveenv";

type ToolPart = Extract<WaveUIMessagePart, { type: "data-tooluse" }>;
type Scenario =
    | "approve"
    | "deny"
    | "retry"
    | "abort"
    | "missing"
    | "invalid"
    | "consecutive"
    | "reorder"
    | "history"
    | "long"
    | "ack-end"
    | "ack-stop"
    | "ack-error"
    | "timeout"
    | "bidi"
    | "batch-focus";
type Decision = { toolcallid: string; approval: "user-approved" | "user-denied" };
type PendingDecision = { data: Decision; resolve: () => void; reject: (error: Error) => void };

const BlockId = "11111111-2222-4333-8444-555555555555";
const ChatId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const Commands = ['  printf "%s" "a  b"  ', 'printf "%s" "café 雪 👩‍💻 <b>literal</b> $(never-run) `never-run` ; & | >"'];
const Scenarios: Scenario[] = [
    "approve",
    "deny",
    "retry",
    "abort",
    "missing",
    "invalid",
    "consecutive",
    "reorder",
    "history",
    "long",
    "ack-end",
    "ack-stop",
    "ack-error",
    "timeout",
    "bidi",
    "batch-focus",
];

function makeFixture(scenario: Scenario) {
    let controller: ReadableStreamDefaultController<Uint8Array> = null;
    let active = false;
    let round = 0;
    let slots: ToolPart[] = [];
    let history: WaveUIMessage[] = [];
    const requests: unknown[] = [];
    const rpc: { method: string; data: unknown; opts?: RpcOpts }[] = [];
    const wire: RpcMessage[] = [];
    const timeoutClient = new WshClient("fixture-timeout");
    const oldRouter = DefaultRouter;
    const decisions: Decision[] = [];
    const writes: { toolcallid: string; command: string; blockid: string; tabid: string; connection: string }[] = [];
    const violations: string[] = [];
    const pending = new Map<string, PendingDecision>();
    const accepted = new Map<string, Decision>();
    let aborts = 0;
    let historyloads = 0;
    let telemetryblocked = 0;
    const encoder = new TextEncoder();

    function fail(message: string): never {
        violations.push(message);
        throw new Error(message);
    }

    function makePart(index: number, command = Commands[index % Commands.length]): ToolPart {
        return {
            type: "data-tooluse",
            id: `slot-${index}`,
            data: {
                toolcallid: `fixture-call-${round}-${index}`,
                toolname: index % 2 ? "terminal.propose_command" : "terminal_propose_command",
                tooldesc: "proposing terminal.propose_command",
                status: "pending",
                approval: "needs-approval",
                terminalproposal: { command, blockid: BlockId, tabid: PreviewTabId, connection: "" },
            },
        };
    }

    if (scenario === "history") {
        slots = [makePart(0), makePart(1)];
        slots[0].data.status = "completed";
        slots[0].data.approval = "user-approved";
        history = [{ id: "history", role: "assistant", parts: [...slots].reverse() }];
    }

    function snapshot() {
        return structuredClone({
            scenario,
            requests,
            rpc,
            wire,
            openrpcs: timeoutClient.openRpcs.size,
            decisions,
            writes,
            violations,
            aborts,
            historyloads,
            telemetryblocked,
            pending: [...pending.keys()],
            active,
            slots,
            fakeexecutioncount: writes.reduce(
                (count, write) => count + (write.command.match(/[\r\n]/g)?.length ?? 0),
                0
            ),
        });
    }

    function emit(chunk: unknown) {
        if (!active) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    }

    function saveHistory() {
        history = [{ id: `assistant-${round}`, role: "assistant", parts: structuredClone(slots) }];
    }

    function finish() {
        if (!active) return;
        emit({ type: "finish", finishReason: "stop" });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        active = false;
        controller.close();
        saveHistory();
    }

    function abort() {
        if (!active) return;
        active = false;
        aborts++;
        slots = slots.map((part) => ({
            ...part,
            data:
                part.data.status === "pending" && !scenario.startsWith("ack-")
                    ? {
                          ...part.data,
                          status: "error",
                          approval: "timeout",
                          errormessage: "Fixture stream canceled; nothing typed",
                      }
                    : part.data,
        }));
        saveHistory();
        for (const request of pending.values()) request.reject(new Error("Fixture approval canceled"));
        pending.clear();
        try {
            controller.close();
        } catch {
            /* The stream may already be canceled by its consumer. */
        }
    }

    function releaseRpc(toolcallid: string, outcome: "success" | "error" = "success") {
        const request = pending.get(toolcallid);
        if (!request) fail(`No pending fixture RPC for ${toolcallid}`);
        pending.delete(toolcallid);
        if (outcome === "error") {
            request.reject(new Error("Fixture approval RPC unavailable; safe to retry"));
            return;
        }
        if (!active) {
            request.reject(new Error("Fixture stream no longer active"));
            return;
        }
        const part = slots.find((value) => value.data.toolcallid === toolcallid);
        if (!part || part.data.status !== "pending" || accepted.has(toolcallid)) {
            request.reject(new Error("Fixture stale or duplicate decision"));
            return;
        }
        if (request.data.approval === "user-approved") {
            const proposal = part.data.terminalproposal;
            if (!proposal || proposal.blockid !== BlockId || proposal.tabid !== PreviewTabId) {
                request.reject(new Error("Fixture invalid proposal"));
                return;
            }
            writes.push({ toolcallid, ...structuredClone(proposal) });
        }
        accepted.set(toolcallid, structuredClone(request.data));
        request.resolve();
    }

    function publish(toolcallid: string) {
        const part = slots.find((value) => value.data.toolcallid === toolcallid);
        const decision = accepted.get(toolcallid);
        if (!active || !part || !decision || pending.has(toolcallid))
            fail("Cannot publish unresolved fixture decision");
        part.data = {
            ...part.data,
            status: decision.approval === "user-approved" ? "completed" : "error",
            approval: decision.approval,
            errormessage: decision.approval === "user-denied" ? "User denied; nothing typed" : undefined,
        };
        emit(part);
        if (scenario === "consecutive" && slots.length === 1) {
            slots.push(makePart(1));
            emit(slots[1]);
            return;
        }
        if (slots.every((value) => value.data.status !== "pending")) finish();
    }

    function reorder() {
        if (!active || slots.length !== 2) fail("Reorder needs two active fixture calls");
        const reversed = [...slots].reverse();
        // SSE replaces one data slot at a time; vacate it first to avoid a transient duplicate call ID.
        emit({
            ...slots[0],
            data: {
                ...slots[0].data,
                toolcallid: `fixture-reorder-placeholder-${round}`,
                status: "error",
                approval: "timeout",
            },
        });
        slots = reversed.map((part, index) => ({ ...part, id: `slot-${index}` }));
        emit(slots[1]);
        emit(slots[0]);
    }

    function endWithoutStatus(error = false) {
        if (!active) fail("No fixture stream to end");
        if (!error) {
            finish();
            return;
        }
        active = false;
        saveHistory();
        controller.error(new Error("Fixture stream interrupted after decision acknowledgment"));
    }

    function updateBatch(phase: "move" | "add" | "remove" | "restore" | "reorder") {
        if (scenario !== "batch-focus" || !active) fail("No active file batch fixture");
        const other = slots.find((part) => part.data.toolcallid === "file-c");
        if (phase === "move" || phase === "add") {
            other.data = {
                ...other.data,
                status: phase === "move" ? "completed" : "pending",
                approval: phase === "move" ? "auto-approved" : "needs-approval",
            };
        } else if (phase === "remove") {
            other.data = { ...other.data, toolname: "fixture_removed", status: "completed", approval: "auto-approved" };
        } else if (phase === "restore") {
            const extra = {
                ...makePart(2),
                data: {
                    toolcallid: "file-a",
                    toolname: "read_text_file",
                    tooldesc: "File a",
                    status: "pending",
                    approval: "needs-approval",
                },
            } as ToolPart;
            slots.push(extra);
            emit(extra);
            other.data = { ...other.data, toolname: "read_text_file", status: "pending", approval: "needs-approval" };
        } else {
            const extra = slots.find((part) => part.data.toolcallid === "file-a");
            emit({
                ...other,
                data: {
                    ...other.data,
                    toolcallid: "file-placeholder",
                    toolname: "fixture_removed",
                    status: "completed",
                    approval: "auto-approved",
                },
            });
            const oldId = other.id;
            other.id = extra.id;
            extra.id = oldId;
            emit(other);
            emit(extra);
            return;
        }
        emit(other);
    }

    if (scenario === "timeout") {
        // The real WshClient generator owns the deadline; only its wire router is inert.
        setDefaultRouter({
            recvRpcMessage(message: RpcMessage) {
                wire.push(structuredClone(message));
                if (message.command !== "waveaitoolapprove" || !message.reqid)
                    fail("Unexpected timeout fixture wire message");
                pending.set(message.data.toolcallid, {
                    data: message.data,
                    resolve: () => timeoutClient.recvRpcMessage({ resid: message.reqid }),
                    reject: (error) => timeoutClient.recvRpcMessage({ resid: message.reqid, error: error.message }),
                });
            },
        } as typeof DefaultRouter);
    }

    const oldFetch = window.fetch;
    const oldEventSource = window.EventSource;
    const oldRpcClient = RpcApi.mockClient;
    RpcApi.setMockRpcClient({
        async mockWshRpcCall(_client, method, data, opts) {
            rpc.push({ method, data: structuredClone(data), opts: structuredClone(opts) });
            switch (method) {
                case "getrtinfo":
                    return { "waveai:chatid": ChatId, "waveai:mode": "fixture" };
                case "setrtinfo":
                    return;
                case "getwaveaichat":
                    historyloads++;
                    return { messages: structuredClone(history) };
                case "getwaveairatelimit":
                    return { unknown: true };
                case "recordtevent":
                    telemetryblocked++;
                    return;
                case "waveaitoolapprove": {
                    if (!active) throw new Error("Fixture approval is not active");
                    if (pending.has(data.toolcallid)) fail("Duplicate concurrent approval RPC");
                    if (!["user-approved", "user-denied"].includes(data.approval)) fail("Unexpected approval decision");
                    decisions.push(structuredClone(data));
                    if (scenario === "timeout") {
                        if (!(opts?.timeout > 0)) fail("Approval RPC requires a finite timeout");
                        try {
                            return await timeoutClient.wshRpcCall(method, data, opts);
                        } finally {
                            pending.delete(data.toolcallid);
                        }
                    }
                    return new Promise<void>((resolve, reject) =>
                        pending.set(data.toolcallid, { data, resolve, reject })
                    );
                }
                default:
                    return fail(`Blocked unexpected global RPC ${method}`);
            }
        },
        async *mockWshRpcStream(_client, method) {
            fail(`Blocked unexpected global streaming RPC ${method}`);
        },
    });

    // The production endpoint deliberately becomes null in previews; only this inert relative endpoint is accepted.
    window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (
            url.origin !== location.origin ||
            url.pathname !== "/null/api/post-chat-message" ||
            init?.method !== "POST"
        ) {
            return fail(`Blocked unexpected fixture fetch ${url.origin}${url.pathname}`);
        }
        if (active) return fail("Concurrent fixture HTTP streams");
        const body = JSON.parse(String(init.body));
        if (body.tabid !== PreviewTabId || body.aimode !== "fixture") return fail("Unexpected fixture request scope");
        requests.push(structuredClone(body));
        round++;
        slots = [makePart(0)];
        if (scenario === "missing") delete slots[0].data.terminalproposal;
        if (scenario === "invalid") slots[0].data.terminalproposal.blockid = "11111111";
        if (scenario === "bidi") slots[0].data.terminalproposal.command = "printf safe‮evil";
        if (scenario === "batch-focus") {
            slots = [makePart(0), makePart(1)].map((part, index) => ({
                ...part,
                data: {
                    toolcallid: index ? "file-c" : "file-b",
                    toolname: "read_text_file",
                    tooldesc: index ? "File c" : "File b",
                    status: "pending",
                    approval: "needs-approval",
                },
            }));
        }
        if (scenario === "long") slots[0].data.terminalproposal.command = `  ${"literal_雪_<tag>_".repeat(80)}  `;
        if (scenario === "reorder") slots.push(makePart(1));
        const stream = new ReadableStream<Uint8Array>({
            start(value) {
                controller = value;
                active = true;
            },
            cancel() {
                abort();
            },
        });
        init.signal?.addEventListener("abort", abort, { once: true });
        emit({ type: "start", messageId: `assistant-${round}` });
        if (scenario === "long") {
            emit({ type: "text-start", id: "intro" });
            emit({
                type: "text-delta",
                id: "intro",
                delta: "Inert fixture transcript. No shell exists here.\n\n".repeat(30),
            });
            emit({ type: "text-end", id: "intro" });
        }
        slots.forEach(emit);
        return new Response(stream, {
            headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
        });
    };
    window.EventSource = class {
        constructor(url: string) {
            if (url !== "http://127.0.0.1:8011/crowe/telemetry/stream") fail(`Blocked unexpected EventSource ${url}`);
            telemetryblocked++;
        }
        close() {}
    } as unknown as typeof EventSource;

    return {
        snapshot,
        releaseRpc,
        publish,
        reorder,
        endWithoutStatus,
        updateBatch,
        dispose() {
            abort();
            window.fetch = oldFetch;
            window.EventSource = oldEventSource;
            RpcApi.setMockRpcClient(oldRpcClient);
            if (scenario === "timeout") setDefaultRouter(oldRouter);
        },
    };
}

export function TerminalApprovalPreview() {
    const env = useWaveEnv();
    const params = new URLSearchParams(location.search);
    const scenario = (params.get("case") || "approve") as Scenario;
    const [width, setWidth] = useState(Number(params.get("width")) || 450);
    const [ready, setReady] = useState(false);
    useLayoutEffect(() => {
        if (!isPreviewWindow() || !env.isMock || !["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) {
            throw new Error("Terminal approval fixture requires a loopback preview environment");
        }
        if (!Scenarios.includes(scenario)) throw new Error("Unknown terminal approval fixture scenario");
        const previousConfig = globalStore.get(atoms.fullConfigAtom);
        const previousModes = globalStore.get(atoms.waveaiModeConfigAtom);
        globalStore.set(atoms.waveaiModeConfigAtom, {
            fixture: { "display:name": "Inert approval fixture", "ai:provider": "fixture" },
        });
        globalStore.set(atoms.fullConfigAtom, {
            settings: { "waveai:defaultmode": "fixture", "telemetry:enabled": false },
        } as FullConfigType);
        const fixture = makeFixture(scenario);
        (window as any).terminalApprovalFixture = fixture;
        const objects = [
            { otype: "window", oid: PreviewWindowId, version: 1, workspaceid: PreviewWorkspaceId },
            { otype: "workspace", oid: PreviewWorkspaceId, version: 1, meta: {}, tabids: [PreviewTabId] },
            { otype: "tab", oid: PreviewTabId, version: 1, meta: {}, blockids: [BlockId] },
            { otype: "block", oid: BlockId, version: 1, meta: { view: "term", connection: "" } },
        ] as WaveObj[];
        // Full-panel globals still read WOS directly rather than the contextual mock environment.
        const orefs = objects.map((object) => {
            const oref = WOS.makeORef(object.otype, object.oid);
            WOS.mockObjectForPreview(oref, object);
            return oref;
        });
        let mounted = true;
        Promise.all(orefs.map((oref) => WOS.reloadWaveObject(oref))).then(() => {
            if (mounted) setReady(true);
        });
        return () => {
            mounted = false;
            fixture.dispose();
            delete (window as any).terminalApprovalFixture;
            globalStore.set(atoms.fullConfigAtom, previousConfig);
            globalStore.set(atoms.waveaiModeConfigAtom, previousModes);
        };
    }, [env, scenario]);
    return (
        <div className="flex min-h-0 flex-col gap-2">
            <label className="flex items-center gap-2 text-xs">
                Inert full-panel fixture
                <input
                    aria-label="Fixture pane width"
                    type="range"
                    min={320}
                    max={720}
                    value={width}
                    onChange={(event) => setWidth(Number(event.target.value))}
                />
                <output>{width}px</output>
            </label>
            <div data-testid="terminal-approval" className="h-[740px] shrink-0 border border-border" style={{ width }}>
                {ready && <AIPanel roundTopLeft={false} />}
            </div>
        </div>
    );
}
