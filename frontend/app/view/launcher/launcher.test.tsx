// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const Harness = vi.hoisted(() => ({ replace: vi.fn(), connect: vi.fn(), collapse: vi.fn(), visible: vi.fn() }));
vi.mock("react", async (load) => ({ ...(await load<typeof import("react")>()), useEffect: () => {} }));
vi.mock("jotai", async (load) => {
    const actual = await load<typeof import("jotai")>();
    return {
        ...actual,
        useAtom: (target: any) => [
            actual.getDefaultStore().get(target),
            (value: any) => actual.getDefaultStore().set(target, value),
        ],
        useAtomValue: (target: any) => actual.getDefaultStore().get(target),
    };
});
vi.mock("@/app/store/global", async () => {
    const { atom, getDefaultStore } = await import("jotai");
    return {
        atoms: { fullConfigAtom: atom({ widgets: {} }) },
        globalStore: getDefaultStore(),
        replaceBlock: Harness.replace,
    };
});
vi.mock("@/app/aipanel/waveai-model", () => ({
    WaveAIModel: { getInstance: () => ({ openCroweAccount: Harness.connect }) },
}));
vi.mock("@/app/dock/dock-model", () => ({ DockModel: { getInstance: () => ({ collapse: Harness.collapse }) } }));
vi.mock("@/app/workspace/workspace-layout-model", () => ({
    WorkspaceLayoutModel: { getInstance: () => ({ setAIPanelVisible: Harness.visible }) },
}));
vi.mock("@/util/util", () => ({
    cn: (...values: any[]) => values.filter(Boolean).join(" "),
    makeIconClass: () => "fa-terminal",
}));

import { atoms, globalStore } from "@/app/store/global";
import { LauncherView, LauncherViewModel } from "./launcher";

function nodes(tree: any): any[] {
    if (!tree || typeof tree !== "object") return [];
    return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}

const Terminal = {
    label: "Terminal",
    description: "Run a shell",
    "display:order": 1,
    blockdef: { meta: { view: "term" } },
};
const Files = {
    label: "Files",
    description: "Browse folders",
    "display:order": 2,
    blockdef: { meta: { view: "preview" } },
};

function makeModel() {
    return new LauncherViewModel({ blockId: "test-block", nodeModel: {}, tabModel: {} } as ViewModelInitType);
}

function render(model: LauncherViewModel) {
    return nodes(LauncherView({ model } as ViewComponentProps<LauncherViewModel>));
}

function action(tree: any[], name: string) {
    return tree.find((node) => node.type === "button" && nodes(node).some((child) => child.props.children === name));
}

describe("Launcher workspace", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("document", { activeElement: null });
        globalStore.set(atoms.fullConfigAtom, {
            widgets: { files: Files, terminal: Terminal, hidden: { ...Terminal, "display:hidden": true } },
        } as any);
    });

    it("filters only visible tools by normalized name and description", () => {
        const model = makeModel();
        expect(globalStore.get(model.filteredWidgetsAtom)).toEqual([Terminal, Files]);
        globalStore.set(model.searchTerm, "  SHELL  ");
        expect(globalStore.get(model.filteredWidgetsAtom)).toEqual([Terminal]);
        globalStore.set(model.searchTerm, "files");
        expect(globalStore.get(model.filteredWidgetsAtom)).toEqual([Files]);
        globalStore.set(model.searchTerm, "   ");
        expect(globalStore.get(model.filteredWidgetsAtom)).toEqual([Terminal, Files]);
    });

    it("opens real account setup and the existing operator panel without launching a website", () => {
        const model = makeModel();
        const tree = render(model);
        action(tree, "Connect account").props.onClick();
        expect(Harness.connect).toHaveBeenCalledOnce();
        action(tree, "Operator panel").props.onClick();
        expect(Harness.collapse).toHaveBeenCalledOnce();
        expect(Harness.visible).toHaveBeenCalledExactlyOnceWith(true);
        expect(Harness.replace).not.toHaveBeenCalled();
        expect(tree.some((node) => node.props.href)).toBe(false);
        expect(JSON.stringify(tree)).not.toMatch(
            /crowelm\.com|signed workspace|crowe-launcher-stats|crowe-launcher-live/
        );
    });

    it("opens editor destinations and tools through their block definitions", () => {
        const model = makeModel();
        const tree = render(model);
        action(tree, "Crowe Code").props.onClick();
        expect(Harness.replace).toHaveBeenCalledWith("test-block", { meta: { view: "crowecode" } }, true);
        action(tree, "Terminal").props.onClick();
        expect(Harness.replace).toHaveBeenCalledWith("test-block", Terminal.blockdef, true);
        expect(tree.filter((node) => node.props.onClick).every((node) => node.type === "button")).toBe(true);
    });

    it("labels the filter honestly, keeps destinations available and clears an empty result", () => {
        const model = makeModel();
        globalStore.set(model.searchTerm, "not-a-tool");
        const tree = render(model);
        expect(tree.find((node) => node.type === "input").props["aria-label"]).toBe("Search tools");
        expect(tree.find((node) => node.props.role === "status").props.children).toContain("No matching tools");
        expect(action(tree, "Connect account")).toBeTruthy();
        action(tree, "Clear").props.onClick();
        expect(globalStore.get(model.searchTerm)).toBe("");
    });

    it("moves actual focus with arrows and leaves native button activation alone", () => {
        const model = makeModel();
        const focusable = () => {
            const target = {
                focus: vi.fn(() => {
                    (document as any).activeElement = target;
                }),
            };
            return target;
        };
        model.inputRef.current = focusable() as any;
        model.toolRefs = [focusable(), focusable()] as any;
        model.inputRef.current.focus();
        const key = (value: string) => model.keyDownHandler({ key: value } as WaveKeyboardEvent);
        expect(key("ArrowDown")).toBe(true);
        expect(document.activeElement).toBe(model.toolRefs[0]);
        key("ArrowDown");
        expect(document.activeElement).toBe(model.toolRefs[1]);
        expect(key("Enter")).toBe(false);
        expect(key(" ")).toBe(false);
        expect(Harness.replace).not.toHaveBeenCalled();
        key("Escape");
        expect(document.activeElement).toBe(model.inputRef.current);
        key("Enter");
        expect(Harness.replace).toHaveBeenCalledExactlyOnceWith("test-block", Terminal.blockdef, true);
        expect(key("ArrowLeft")).toBe(false);
    });

    it("does not submit while composing text or leak filters between blocks", () => {
        const first = makeModel();
        const second = makeModel();
        globalStore.set(first.searchTerm, "shell");
        expect(globalStore.get(second.searchTerm)).toBe("");
        const input = render(first).find((node) => node.type === "input");
        input.props.onKeyDown({ nativeEvent: { isComposing: true }, key: "Enter" });
        expect(Harness.replace).not.toHaveBeenCalled();
    });
});
