// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const Harness = vi.hoisted(() => ({
    configs: {} as Record<string, any>,
    current: "local",
    setMode: vi.fn(),
    openAccount: vi.fn(),
    focus: vi.fn(),
    collapse: vi.fn(),
}));
vi.mock("jotai", () => ({ useAtomValue: (key: string) => (key === "configs" ? Harness.configs : Harness.current) }));
vi.mock("./dock-model", () => ({ DockModel: { getInstance: () => ({ collapse: Harness.collapse }) } }));
vi.mock("@/app/aipanel/croweaccount-model", () => ({
    isCroweAccountMode: (_key: string, config: any) => config["ai:apitype"] === "crowe-gateway",
}));
vi.mock("@/app/aipanel/waveai-model", () => ({
    WaveAIModel: {
        getInstance: () => ({
            aiModeConfigs: "configs",
            currentAIMode: "current",
            setAIMode: Harness.setMode,
            openCroweAccount: Harness.openAccount,
            focusInput: Harness.focus,
        }),
    },
}));
vi.mock("@/app/store/global", () => ({ atoms: {} }));
vi.mock("@/app/store/wos", () => ({}));
vi.mock("@/util/util", () => ({ cn: (...values: string[]) => values.filter(Boolean).join(" ") }));
vi.mock("./designreview-model", () => ({ DesignReviewModel: {} }));
vi.mock("./telemetry-model", () => ({ TelemetryModel: {} }));
vi.mock("./vcs-model", () => ({ VcsModel: {} }));

import { activityLabel, endpointDisplay, ModelPanel } from "./dockpanels";

function nodes(tree: any): any[] {
    if (!tree || typeof tree !== "object") return [];
    return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}

function text(tree: any): string {
    if (tree == null || typeof tree === "boolean") return "";
    if (typeof tree !== "object") return String(tree);
    return [tree.props?.children].flat(Infinity).map(text).join("");
}

describe("Engine navigation", () => {
    it("offers account navigation and returns to the operator after selecting an engine", () => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        Harness.configs = {
            local: { "display:name": "Local engine", "ai:endpoint": "http://localhost:1234/v1" },
            account: { "display:name": "Crowe account", "ai:apitype": "crowe-gateway" },
        };
        const tree = ModelPanel();
        const buttons = nodes(tree).filter((node) => node.type === "button");
        buttons.find((button) => text(button) === "Open Crowe account").props.onClick();
        expect(Harness.openAccount).toHaveBeenCalledOnce();
        buttons.find((button) => text(button).includes("Local engine")).props.onClick();
        expect(Harness.setMode).toHaveBeenCalledWith("local");
        expect(Harness.collapse).toHaveBeenCalledOnce();
        expect(Harness.focus).not.toHaveBeenCalled();
        vi.runAllTimers();
        vi.useRealTimers();
        expect(Harness.focus).toHaveBeenCalledOnce();
        expect(text(tree)).toContain("Nothing sends until you submit");
        expect(text(tree)).toContain("Advanced setup");
        expect(text(tree)).toContain("Crowe account sign-in");
    });
});

describe("Configured endpoint display", () => {
    it.each(["http://127.0.0.1:8011/v1", "http://localhost:4000/path", "http://[::1]:4000/path"])(
        "labels only the local hop for %s",
        (value) => {
            expect(endpointDisplay(value).location).toBe("Loopback endpoint");
        }
    );

    it("keeps remote endpoints remote and strips non-origin data", () => {
        expect(endpointDisplay("https://example.test/private?sample=value#fragment")).toEqual({
            origin: "https://example.test",
            location: "Remote endpoint",
        });
        expect(endpointDisplay("https://sample-user:sample-pass@example.test/path").origin).toBe(
            "https://example.test"
        );
    });

    it.each(["broken example", "file:///example", "javascript:void(0)"])(
        "does not echo invalid values: %s",
        (value) => {
            expect(endpointDisplay(value)).toEqual({ origin: "Invalid endpoint", location: "Unknown endpoint" });
        }
    );

    it("does not invent an endpoint", () => {
        expect(endpointDisplay(null).origin).toBe("Not specified");
    });
});

describe("Observed activity", () => {
    it("does not invent cognition while waiting", () => {
        expect(activityLabel("running", "idle", "")).toBe("Waiting for response");
    });
    it("uses recorded events and outcomes", () => {
        expect(activityLabel("running", "tool", "read-file")).toBe("Tool event: read-file");
        expect(activityLabel("running", "responding", "stale-tool")).toBe("Receiving response");
        expect(activityLabel("running", "reasoning", "")).toBe("Receiving reasoning output");
        expect(activityLabel("error", "idle", "")).toBe("Run ended with an error");
        expect(activityLabel("done", "idle", "")).toBe("Run complete");
        expect(activityLabel("idle", "idle", "")).toBe("No active run");
    });
});
