// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const Harness = vi.hoisted(() => ({
    values: {} as Record<string, any>,
    width: 800,
    column: vi.fn(),
    tool: vi.fn(),
    commit: vi.fn(),
    visible: vi.fn(),
    collapse: vi.fn(),
}));
vi.mock("react", async (load) => ({
    ...(await load<typeof import("react")>()),
    memo: (fn: any) => fn,
    useState: (initial: any) => [
        typeof initial === "number" ? Harness.width : typeof initial === "function" ? initial() : initial,
        vi.fn(),
    ],
    useRef: () => ({ current: null }),
    useCallback: (fn: any) => fn,
    useEffect: vi.fn(),
}));
vi.mock("jotai", () => ({ useAtomValue: (key: string) => Harness.values[key] }));
vi.mock("./dock-model", async (load) => ({
    ...(await load<typeof import("./dock-model")>()),
    DockModel: {
        getInstance: () => ({
            activeToolAtom: "active",
            collapsedAtom: "collapsed",
            columnWidthAtom: "column",
            toolWidthAtom: "tool",
            setColumnWidth: Harness.column,
            setToolWidth: Harness.tool,
            commitPersist: Harness.commit,
            collapse: Harness.collapse,
            toggle: vi.fn(),
        }),
    },
}));
vi.mock("@/app/store/jotaiStore", () => ({ globalStore: {} }));
vi.mock("@/app/aipanel/aipanel", () => ({ AIPanel: "operator-stream" }));
vi.mock("@/app/asset/hypheus-mark.png", () => ({ default: "mark" }));
vi.mock("@/app/aipanel/waveai-model", () => ({
    WaveAIModel: { getInstance: () => ({ currentAIMode: "mode", aiModeConfigs: "configs" }) },
}));
vi.mock("@/app/workspace/workspace-layout-model", () => ({
    WorkspaceLayoutModel: {
        getInstance: () => ({
            panelVisibleAtom: "chat",
            getAIPanelVisible: () => Harness.values.chat,
            setAIPanelVisible: Harness.visible,
        }),
    },
}));
vi.mock("@/app/theme/app-theme", () => ({ getAppTheme: () => "dark", applyAppTheme: vi.fn() }));
vi.mock("@/util/util", () => ({ cn: (...values: any[]) => values.filter(Boolean).join(" ") }));
vi.mock("./crowe-icons", () =>
    Object.fromEntries(
        ["Assistant", "Close", "Hyphae", "Moon", "Network", "Nib", "Rings", "Spore", "Sun", "Vitals"].map((name) => [
            name + "Icon",
            "svg",
        ])
    )
);
vi.mock("./designreview-model", () => ({ DesignReviewModel: {} }));
vi.mock("./vcs-model", () => ({ VcsModel: {} }));
vi.mock("./dockpanels", () =>
    Object.fromEntries(
        ["Design", "Model", "Mycelium", "Telemetry", "Thinking", "Vcs"].map((name) => [name + "Panel", "tool-panel"])
    )
);

import { UtilityDock } from "./utilitydock";

function nodes(tree: any): any[] {
    if (!tree || typeof tree !== "object") return [];
    return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}
function render() {
    return nodes((UtilityDock as any)());
}
function key(key: string) {
    return { key, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe("Dock interaction wiring", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Harness.width = 800;
        Harness.values = {
            active: "model",
            collapsed: false,
            column: 760,
            tool: 480,
            chat: true,
            mode: "example",
            configs: {},
        };
    });

    it("exposes effective bounds and commits keyboard and reset changes", () => {
        const tree = render();
        const split = tree.find((node) => node.props["aria-label"] === "Tool panel width");
        expect(split.props["aria-valuemax"]).toBe(232);
        expect(split.props["aria-valuenow"]).toBe(232);
        split.props.onKeyDown(key("Home"));
        expect(Harness.tool).toHaveBeenLastCalledWith(200);
        expect(Harness.commit).toHaveBeenCalledTimes(1);
        split.props.onDoubleClick();
        expect(Harness.tool).toHaveBeenLastCalledWith(232);
        expect(Harness.commit).toHaveBeenCalledTimes(2);
    });

    it("resizes the tool rather than the hidden operator in tool-only mode", () => {
        Harness.values.chat = false;
        const grip = render().find((node) => node.props.role === "separator");
        grip.props.onKeyDown(key("Home"));
        expect(Harness.tool).toHaveBeenCalledWith(200);
        expect(Harness.column).not.toHaveBeenCalled();
    });

    it("retains one unkeyed operator subtree when hidden or in compact mode", () => {
        for (const [chat, width] of [
            [true, 1200],
            [false, 1200],
            [true, 700],
        ] as const) {
            Harness.values.chat = chat;
            Harness.width = width;
            const tree = render();
            const streams = tree.filter((node) => node.type === "operator-stream");
            expect(streams).toHaveLength(1);
            expect(streams[0].key).toBeNull();
            const pane = tree.find((node) => node.props.id === "crowe-operator-pane");
            expect(pane.props.style.display).toBe(chat && width >= 768 ? "flex" : "none");
        }
    });

    it("delegates a single header and close action to the mounted operator", () => {
        const tree = render();
        expect(tree.some((node) => node.props.className?.includes("crowe-chat-head"))).toBe(false);
        const panel = tree.find((node) => node.type === "operator-stream");
        expect(panel.props.onClose).toBeTypeOf("function");
        panel.props.onClose();
        expect(Harness.visible).toHaveBeenCalledWith(false);
    });

    it("returns from compact tools without changing saved operator visibility", () => {
        Harness.width = 700;
        const button = render().find((node) => node.props["aria-label"] === "Show operator");
        button.props.onClick();
        expect(Harness.collapse).toHaveBeenCalledTimes(1);
        expect(Harness.visible).not.toHaveBeenCalled();
    });
});
