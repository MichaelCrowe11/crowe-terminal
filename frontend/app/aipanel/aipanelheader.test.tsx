// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Harness = vi.hoisted(() => ({
    engine: vi.fn(),
    account: vi.fn(),
    clear: vi.fn(),
    authority: vi.fn(),
    focus: vi.fn(),
    menu: vi.fn(),
    values: {} as Record<string, any>,
}));
vi.mock("react", async (load) => ({
    ...(await load<typeof import("react")>()),
    memo: (component: any) => component,
    useMemo: (fn: () => any) => fn(),
    useEffect: vi.fn(),
    useRef: (current: any) => ({ current }),
    useState: (value: any) => [value, vi.fn()],
}));
vi.mock("jotai", () => ({ useAtomValue: (key: string) => Harness.values[key] }));
vi.mock("./waveai-model", () => ({
    WaveAIModel: {
        getInstance: () => ({
            currentAIMode: "mode",
            aiModeConfigs: "configs",
            widgetAccessAtom: "authority",
            isAIStreaming: "streaming",
            openEngineSelector: Harness.engine,
            openCroweAccount: Harness.account,
            clearChat: Harness.clear,
            setWidgetAccess: Harness.authority,
            focusInput: Harness.focus,
            getPanelVisibleAtom: () => "visible",
        }),
    },
}));
vi.mock("./croweaccount", () => ({ CroweAccountButton: "account-control" }));
vi.mock("./aimessage", () => ({ AIMessage: "message" }));
vi.mock("@/app/aipanel/aipanel-contextmenu", () => ({ handleWaveAIContextMenu: Harness.menu }));
vi.mock("@/app/view/crowecode/crowecode-workspace-model", () => ({
    CroweCodeWorkspaceModel: { getInstance: () => ({ activeEditorAtom: "editor" }) },
}));
vi.mock("@/util/util", () => ({ cn: (...values: any[]) => values.filter(Boolean).join(" ") }));

import { AIPanelHeader } from "./aipanelheader";
import { AIPanelMessages } from "./aipanelmessages";

function nodes(tree: any): any[] {
    if (!tree || typeof tree !== "object") return [];
    return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}

beforeEach(() => {
    vi.clearAllMocks();
    Harness.values = {
        mode: "local",
        configs: { local: { "display:name": "Local engine" } },
        authority: true,
        visible: true,
    };
});

describe("Operator header", () => {
    it("has one header with in-app engine/account navigation and separate tool authority", () => {
        const close = vi.fn();
        const tree = nodes((AIPanelHeader as any)({ onClose: close }));
        const header = tree.find((node) => node.type === "header");
        expect(tree.filter((node) => node.type === "header")).toHaveLength(1);
        const controls = nodes(header);
        controls
            .find((node) => node.props["aria-label"] === "Choose engine. Current engine: Local engine")
            .props.onClick();
        controls.find((node) => node.type === "account-control").props.onClick();
        controls.find((node) => node.props["aria-label"] === "Close operator").props.onClick();
        expect(Harness.engine).toHaveBeenCalledOnce();
        expect(Harness.account).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(Harness.clear).not.toHaveBeenCalled();
        expect(controls.some((node) => node.props["aria-label"] === "Tool authority")).toBe(false);
        const authority = tree.find((node) => node.props["aria-label"] === "Tool authority");
        expect(nodes(authority).find((node) => node.type === "button").props["aria-pressed"]).toBe(true);
        expect(tree.some((node) => node.type === "a" || node.props.href)).toBe(false);
    });
});

describe("Transcript recovery layout", () => {
    it("places empty-chat recovery before welcome starters without moving the transcript footer", () => {
        const source = readFileSync(new URL("./aipanel.tsx", import.meta.url), "utf8");
        const emptyBranch = source.slice(source.indexOf("{emptyChat ? ("), source.indexOf("<AIPanelMessages"));
        expect(emptyBranch.indexOf("{recovery}")).toBeGreaterThan(-1);
        expect(emptyBranch.indexOf("{recovery}")).toBeLessThan(emptyBranch.indexOf("<AIWelcomeMessage"));
        expect(source.replace(/\s+/g, "")).toContain("footer={<>{accountSetup}{recovery}</>}");
    });

    it("keeps account recovery in the existing transcript scroll owner", () => {
        const footer = <section aria-label="Connection recovery">Reconnect without replacing this chat</section>;
        const message = { id: "existing-message", role: "user", parts: [{ type: "text", text: "Keep this request" }] };
        const tree = (AIPanelMessages as any)({ messages: [message], status: "ready", footer });
        expect(tree.props.className).toContain("overflow-y-auto");
        expect(tree.props.className).toContain("min-h-0");
        const descendants = nodes(tree);
        expect(descendants.find((node) => node.type === "message").props.message).toBe(message);
        expect(descendants).toContain(footer);
        expect(descendants.filter((node) => node.props.className?.includes("overflow-y-auto"))).toHaveLength(1);
    });
});
