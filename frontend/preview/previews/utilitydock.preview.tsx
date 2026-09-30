// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CroweAccountMode, CroweAccountModel } from "@/app/aipanel/croweaccount-model";
import { WaveAIModel } from "@/app/aipanel/waveai-model";
import hypheusWordmark from "@/app/asset/hypheus-wordmark.svg?url";
import { DockModel } from "@/app/dock/dock-model";
import { TelemetryModel } from "@/app/dock/telemetry-model";
import { UtilityDock } from "@/app/dock/utilitydock";
import { VcsModel } from "@/app/dock/vcs-model";
import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { MockRpcClient, RpcApi } from "@/app/store/wshclientapi";
import { applyAppTheme, getAppTheme } from "@/app/theme/app-theme";
import { useWaveEnv, WaveEnvContext } from "@/app/waveenv/waveenv";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { cn } from "@/util/util";
import { useEffect, useState } from "react";
import { DefaultFullConfig } from "../mock/defaultconfig";
import { PreviewWindowId, PreviewWorkspaceId } from "../mock/mockwaveenv";

const FixtureNames = ["signedout", "pending", "connected", "storage", "legacykey"] as const;
type FixtureName = (typeof FixtureNames)[number];
const Widths = [280, 320, 460];
const PreviewReply = "Preview response only. No model, terminal, file, or account service was contacted.";

type PreviewDiagnostics = {
    calls: string[];
    blocked: string[];
    externalactions: number;
    submissions: number;
    active: boolean;
};

function installPreviewIsolation(fixture: FixtureName, width: number, theme: "dark" | "light") {
    const previousClient = RpcApi.mockClient;
    const previousConfig = globalStore.get(atoms.fullConfigAtom);
    const previousModes = globalStore.get(atoms.waveaiModeConfigAtom);
    const previousTheme = getAppTheme();
    const api = getApi();
    const previousExternal = api.openExternal;
    const previousFetch = window.fetch;
    const previousOpen = window.open;
    const telemetry = TelemetryModel.getInstance();
    const connectDescriptor = Object.getOwnPropertyDescriptor(telemetry, "connect");
    const suppressConnect = () => {};
    telemetry.connect = suppressConnect;
    const diagnostics: PreviewDiagnostics = {
        calls: [],
        blocked: [],
        externalactions: 0,
        submissions: 0,
        active: true,
    };
    const tabId = globalStore.get(atoms.staticTabId);
    const oref = `tab:${tabId}`;
    const mode = fixture === "legacykey" ? "waveai@crowelm-auto" : CroweAccountMode;
    const rtinfo: Record<string, unknown> = { "waveai:mode": mode };
    const pending: CroweAuthStatus = { state: "pending", usercode: "PREVIEW-ONLY" };
    let status: CroweAuthStatus =
        fixture === "pending"
            ? pending
            : fixture === "connected"
              ? { state: "connected" }
              : fixture === "storage"
                ? { state: "error", message: "Crowe account secure storage is unavailable" }
                : { state: "signedout" };
    let tab = { otype: "tab", oid: tabId, version: 1, name: "Preview workspace", blockids: [], meta: {} } as Tab;
    const windowFixture = {
        otype: "window",
        oid: PreviewWindowId,
        version: 1,
        workspaceid: PreviewWorkspaceId,
    } as WaveWindow;
    const workspaceFixture = {
        otype: "workspace",
        oid: PreviewWorkspaceId,
        version: 1,
        name: "Preview workspace",
        tabids: [tabId],
        activetabid: tabId,
        meta: {},
    } as Workspace;
    for (const obj of [windowFixture, workspaceFixture, tab]) {
        const objref = WOS.makeORef(obj.otype, obj.oid);
        WOS.mockObjectForPreview(objref, obj);
        WOS.getWaveObjectAtom(objref);
        WOS.setObjectValue(obj);
    }
    const block = (command: string): never => {
        diagnostics.blocked.push(command);
        throw new Error(`Operator preview blocked unsupported action: ${command}`);
    };
    const mockClient: MockRpcClient = {
        async mockWshRpcCall(_client, command, data) {
            diagnostics.calls.push(command);
            if (!diagnostics.active) return block(`disposed:${command}`);
            switch (command) {
                case "croweauthstatus":
                    return { ...status };
                case "croweauthstart":
                    status = fixture === "storage" ? status : pending;
                    return { ...status };
                case "croweauthcancel":
                case "croweauthdisconnect":
                    status = { state: "signedout" };
                    return { ...status };
                case "getrtinfo":
                    if (data.oref !== oref) return block(command);
                    return { ...rtinfo };
                case "setrtinfo":
                    if (data.oref !== oref) return block(command);
                    Object.assign(rtinfo, data.data);
                    return;
                case "getwaveaichat":
                    return { messages: [] };
                case "getwaveairatelimit":
                    return { unknown: true };
                case "setconfig": {
                    if (Object.keys(data).some((key) => key !== "waveai:defaultmode")) return block(command);
                    const config = globalStore.get(atoms.fullConfigAtom);
                    globalStore.set(atoms.fullConfigAtom, { ...config, settings: { ...config.settings, ...data } });
                    return;
                }
                case "setmeta":
                    if (data.oref !== oref || Object.keys(data.meta).some((key) => !key.startsWith("waveai:")))
                        return block(command);
                    tab = { ...tab, version: tab.version + 1, meta: { ...tab.meta, ...data.meta } };
                    WOS.mockObjectForPreview(oref, tab);
                    WOS.setObjectValue(tab);
                    return;
                case "recordtevent":
                    return;
                case "vcsstatus":
                    return globalStore.get(vcsModel.statusAtom);
                case "vcshistory":
                    return globalStore.get(vcsModel.historyAtom);
                default:
                    return block(command);
            }
        },
        async *mockWshRpcStream(_client, command) {
            block(`stream:${command}`);
        },
    };
    const suppressExternal = () => {
        diagnostics.externalactions++;
    };
    const suppressOpen: typeof window.open = () => {
        suppressExternal();
        return null;
    };
    const guardedFetch: typeof window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString(), window.location.href);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        if (
            url.origin !== window.location.origin ||
            method !== "GET" ||
            /^\/(api|wave|auth|oauth|crowe)(\/|$)/.test(url.pathname)
        ) {
            return block(`fetch:${method}:${url.pathname}`);
        }
        return previousFetch.call(window, input, init);
    };
    // These models bypass WaveEnv. Install the mock before rendering children and
    // never delegate an unknown command to the original RPC client.
    RpcApi.setMockRpcClient(mockClient);
    api.openExternal = suppressExternal;
    window.open = suppressOpen;
    window.fetch = guardedFetch;
    globalStore.set(atoms.fullConfigAtom, {
        ...DefaultFullConfig,
        settings: { ...DefaultFullConfig.settings, "waveai:defaultmode": mode },
    });
    globalStore.set(atoms.waveaiModeConfigAtom, DefaultFullConfig.waveai);
    applyAppTheme(theme, false);
    CroweAccountModel.resetInstance();
    WaveAIModel.resetInstance();
    const account = CroweAccountModel.getInstance();
    account.applyStatus(status);
    const model = WaveAIModel.getInstance();
    const fetchDescriptor = Object.getOwnPropertyDescriptor(model, "fetchChat");
    const previewFetch: typeof model.fetchChat = async (_input, init) => {
        if (!diagnostics.active) return block("disposed:chat");
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        diagnostics.submissions++;
        const events = [
            { type: "start", messageId: `preview-response-${diagnostics.submissions}` },
            { type: "text-start", id: "preview-text" },
            { type: "text-delta", id: "preview-text", delta: PreviewReply },
            { type: "text-end", id: "preview-text" },
            { type: "finish" },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
            headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
        });
    };
    model.fetchChat = previewFetch;
    if (fixture === "legacykey") model.setError("Crowe Logic model authentication is not configured");
    globalStore.set(DockModel.getInstance().columnWidthAtom, width);
    (window as any).operatorPreview = diagnostics;
    return {
        suppressExternal,
        dispose() {
            if (!diagnostics.active) return;
            diagnostics.active = false;
            account.mountCount = 0;
            account.revision++;
            account.clearPollTimer();
            if (vcsModel.pollTimer != null) {
                clearInterval(vcsModel.pollTimer);
                vcsModel.pollTimer = null;
            }
            model.useChatStop?.();
            if (model.fetchChat === previewFetch) {
                if (fetchDescriptor) Object.defineProperty(model, "fetchChat", fetchDescriptor);
                else delete model.fetchChat;
            }
            CroweAccountModel.resetInstance();
            WaveAIModel.resetInstance();
            if (RpcApi.mockClient === mockClient) RpcApi.setMockRpcClient(previousClient);
            if (api.openExternal === suppressExternal) api.openExternal = previousExternal;
            if (window.open === suppressOpen) window.open = previousOpen;
            if (window.fetch === guardedFetch) window.fetch = previousFetch;
            if (telemetry.connect === suppressConnect) {
                if (connectDescriptor) Object.defineProperty(telemetry, "connect", connectDescriptor);
                else delete telemetry.connect;
            }
            globalStore.set(atoms.fullConfigAtom, previousConfig);
            globalStore.set(atoms.waveaiModeConfigAtom, previousModes);
            applyAppTheme(previousTheme, false);
        },
    };
}

const TerminalRows = [
    ["~/Projects/hypheus", "git status --short"],
    ["", "M frontend/app/dock/utilitydock.tsx"],
    ["", "M frontend/app/dock/dock.scss"],
    ["~/Projects/hypheus", "go test ./pkg/agent/..."],
    ["", "ok   github.com/wavetermdev/waveterm/pkg/agent"],
];

// UtilityDock's own child effect (VcsModel.startPolling) fires before this
// file's component effects do, and there is no wavesrv in the preview to
// answer the RPC, so the flag must be set here at module scope -- before
// getInstance() and before any component mounts -- rather than in an effect.
VcsModel.fetchDisabled = true;
const vcsModel = VcsModel.getInstance();
globalStore.set(vcsModel.statusAtom, {
    installed: true,
    isrepo: true,
    dir: "/workspace/hypheus",
    root: "/workspace/hypheus",
    clean: false,
    files: [
        { path: "frontend/app/dock/utilitydock.tsx", changes: 12, plus: 9, minus: 3 },
        { path: "pkg/jj/jj.go", changes: 4, plus: 4, minus: 0 },
    ],
});
globalStore.set(vcsModel.historyAtom, [
    {
        opid: "f0302bfacf0f",
        description: "snapshot working copy",
        time: "2026-08-09 07:05:33",
        timerel: "2 minutes ago",
    },
    {
        opid: "902af479a0b1",
        description: "snapshot working copy",
        time: "2026-08-09 06:51:10",
        timerel: "16 minutes ago",
    },
    {
        opid: "8c1d22aa90ef",
        description: "restore to operation 44f1",
        time: "2026-08-09 06:40:02",
        timerel: "27 minutes ago",
    },
    {
        opid: "44f19c0be2d1",
        description: "snapshot working copy",
        time: "2026-08-09 06:12:44",
        timerel: "55 minutes ago",
    },
]);

// Stand-in for a real block: enough chrome (header, terminal text, footer)
// that reflow under a shrinking column is visible, not just a resized rectangle.
const BlockArea = () => (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-panel px-4">
            <img src={hypheusWordmark} alt="Hypheus" className="h-5 w-auto" />
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                phoenix / operator
            </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-5 font-mono text-xs">
            <div className="mb-5 flex items-center justify-between border-b border-border pb-3 text-muted">
                <span>hypheus / main</span>
                <span>zsh</span>
            </div>
            <div className="space-y-2">
                {TerminalRows.map(([prompt, output], index) => (
                    <div key={index} className={prompt ? "text-foreground" : "text-muted"}>
                        {prompt && <span className="mr-2 text-accent">{prompt} %</span>}
                        {output}
                    </div>
                ))}
                <div className="mt-3 flex items-center text-foreground">
                    <span className="mr-2 text-accent">~/Projects/hypheus %</span>
                    <span className="h-4 w-2 bg-accent" />
                </div>
            </div>
        </div>
        <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-panel px-3 font-mono text-[10px] text-muted">
            <span>main</span>
            <span>local / arm64</span>
        </footer>
    </div>
);

// DockModel and WorkspaceLayoutModel are singletons, so four live UtilityDock
// instances would fight over one piece of shared state. Render one case at a
// time (selected below) instead of laying all four out side by side.
const DockCase = ({ label, chat, tool }: { label: string; chat: boolean; tool: boolean }) => {
    useEffect(() => {
        const dock = DockModel.getInstance();
        const layout = WorkspaceLayoutModel.getInstance();
        globalStore.set(layout.panelVisibleAtom, chat);
        globalStore.set(dock.activeToolAtom, tool ? "repo" : null);
        globalStore.set(dock.collapsedAtom, !tool);
    }, [chat, tool]);

    return (
        <figure className="flex min-w-0 flex-1 flex-col gap-2">
            <figcaption className="font-mono text-[10px] uppercase text-muted">{label}</figcaption>
            <div
                data-testid="operator-workspace"
                className="flex h-[700px] overflow-hidden border border-border bg-background shadow-xl"
            >
                <UtilityDock />
                <BlockArea />
            </div>
        </figure>
    );
};

const Cases = [
    { label: "chat only", chat: true, tool: false },
    { label: "tool only", chat: false, tool: true },
    { label: "both, split", chat: true, tool: true },
    { label: "collapsed", chat: false, tool: false },
];

export function UtilityDockPreview() {
    const params = new URLSearchParams(window.location.search);
    const fixture = FixtureNames.find((name) => name === params.get("account")) ?? "signedout";
    const width = Widths.find((value) => value === Number(params.get("width"))) ?? 320;
    const theme = params.get("theme") === "light" ? "light" : "dark";
    const [caseIdx, setCaseIdx] = useState(0);
    const [isolation, setIsolation] = useState<ReturnType<typeof installPreviewIsolation>>(null);
    const [mounted, setMounted] = useState(true);
    const waveEnv = useWaveEnv();
    const c = Cases[caseIdx];
    useEffect(() => {
        const lease = installPreviewIsolation(fixture, width, theme);
        setIsolation(lease);
        return () => lease.dispose();
    }, [fixture, width, theme]);
    useEffect(() => {
        // The second commit runs after the live panel's cleanup, so its polling
        // cannot resume against the restored RPC client during explicit teardown.
        if (!mounted) isolation?.dispose();
    }, [mounted, isolation]);
    const fixtureLink = (account: string, nextWidth = width, nextTheme = theme) =>
        `?preview=utilitydock&account=${account}&width=${nextWidth}&theme=${nextTheme}`;
    return (
        <div className="flex w-[min(1180px,calc(100vw-32px))] flex-col gap-3" data-testid="operator-preview">
            <p className="rounded border border-border bg-panel px-3 py-2 text-xs" role="note">
                Preview fixtures only. No real account is connected. Browser sign-in, model requests, and backend
                actions are isolated.
            </p>
            <nav aria-label="Preview fixtures" className="flex flex-wrap gap-2 text-xs">
                {FixtureNames.map((name) => (
                    <a
                        key={name}
                        href={fixtureLink(name)}
                        aria-current={fixture === name ? "page" : undefined}
                        className="cursor-pointer border border-border px-2 py-1"
                    >
                        {name}
                    </a>
                ))}
                {Widths.map((value) => (
                    <a
                        key={value}
                        href={fixtureLink(fixture, value)}
                        aria-label={`Preview width ${value}`}
                        className="cursor-pointer border border-border px-2 py-1"
                    >
                        {value}px
                    </a>
                ))}
                <a
                    href={fixtureLink(fixture, width, theme === "dark" ? "light" : "dark")}
                    className="cursor-pointer border border-border px-2 py-1"
                >
                    {theme} theme
                </a>
            </nav>
            <div className="flex flex-wrap gap-2">
                {Cases.map((x, i) => (
                    <button
                        key={x.label}
                        type="button"
                        aria-pressed={i === caseIdx}
                        className={cn(
                            "cursor-pointer border border-border px-2 py-1 font-mono text-[10px] uppercase",
                            i === caseIdx ? "bg-accent/80 text-primary" : "text-muted"
                        )}
                        onClick={() => setCaseIdx(i)}
                    >
                        {x.label}
                    </button>
                ))}
                <button
                    type="button"
                    className="cursor-pointer border border-border px-2 py-1 text-xs"
                    onClick={() => setMounted(false)}
                >
                    Unmount preview
                </button>
            </div>
            {isolation && mounted && (
                <WaveEnvContext.Provider
                    value={{ ...waveEnv, electron: { ...waveEnv.electron, openExternal: isolation.suppressExternal } }}
                >
                    <DockCase
                        label={`${c.label} / ${fixture} fixture / ${width}px / ${theme}`}
                        chat={c.chat}
                        tool={c.tool}
                    />
                </WaveEnvContext.Provider>
            )}
        </div>
    );
}
