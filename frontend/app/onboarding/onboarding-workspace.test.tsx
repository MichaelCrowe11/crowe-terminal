// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Harness = vi.hoisted(() => ({
    effects: [] as (() => void)[],
    state: [] as any[],
    index: 0,
    client: { meta: {} as Record<string, string> },
    meta: vi.fn(),
    event: vi.fn(),
    set: vi.fn(),
    pop: vi.fn(),
    refocus: vi.fn(),
}));
vi.mock("react", async (load) => ({
    ...(await load<typeof import("react")>()),
    useEffect: (effect: () => void) => {
        Harness.effects.push(effect);
    },
    useRef: (value: any) => ({ current: value }),
    useState: (initial: any) => {
        const index = Harness.index++;
        if (!(index in Harness.state)) Harness.state[index] = initial;
        return [
            Harness.state[index],
            (value: any) => {
                Harness.state[index] = value;
            },
        ];
    },
}));
vi.mock("jotai", () => ({ useAtomValue: () => Harness.client }));
vi.mock("@/app/asset/logo.svg", () => ({ default: "svg" }));
vi.mock("@/app/element/button", () => ({ Button: "button" }));
vi.mock("@/app/modals/modal", () => ({ FlexiModal: "div" }));
vi.mock("@/app/store/client-model", () => ({
    ClientModel: { getInstance: () => ({ clientId: "synthetic-client", clientAtom: {} }) },
}));
vi.mock("@/app/store/global", () => ({ globalStore: { set: Harness.set } }));
vi.mock("@/app/store/keymodel", () => ({
    disableGlobalKeybindings: vi.fn(),
    enableGlobalKeybindings: vi.fn(),
    globalRefocus: Harness.refocus,
}));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: { upgradeOnboardingOpen: "upgrade", popModal: Harness.pop } }));
vi.mock("@/app/store/wos", () => ({ makeORef: (type: string, id: string) => `${type}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { SetMetaCommand: Harness.meta, RecordTEventCommand: Harness.event },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("overlayscrollbars-react", () => ({ OverlayScrollbarsComponent: "div" }));

import { CurrentOnboardingVersion } from "./onboarding-common";
import { OnboardingFeatures, WorkspaceWelcome } from "./onboarding-features";
import { UpgradeOnboardingModal } from "./onboarding-upgrade";
import { UpgradeOnboardingMinor } from "./onboarding-upgrade-minor";
import { UpgradeOnboardingFooter, UpgradeOnboardingPatch, UpgradeOnboardingVersions } from "./onboarding-upgrade-patch";

function nodes(tree: any): any[] {
    if (!tree || typeof tree !== "object") return [];
    return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}

function patch(releaseNotes = false) {
    Harness.index = 0;
    return nodes(UpgradeOnboardingPatch({ isReleaseNotes: releaseNotes }));
}

function footer(tree: any[]) {
    return tree.find((node) => node.type === UpgradeOnboardingFooter);
}

describe("Workspace onboarding and release history", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Harness.effects = [];
        Harness.state = [];
        Harness.index = 0;
        Harness.client.meta = {};
        vi.stubGlobal("window", { innerHeight: 900 });
    });

    it("offers one evergreen action into the real workspace, without a simulated tour", () => {
        const complete = vi.fn();
        const tree = WorkspaceWelcome({ onComplete: complete });
        const buttons = nodes(tree).filter((node) => node.type === "button");
        expect(buttons).toHaveLength(1);
        expect(buttons[0].props.children).toBe("Open workspace");
        buttons[0].props.onClick();
        expect(complete).toHaveBeenCalledOnce();
        const html = renderToStaticMarkup(tree);
        expect(html).not.toMatch(/0\.15|FakeChat|Bring your own|API keys|step \d|crowelm\.com/i);
        expect(html).toContain("Connect account");
        expect(html).toContain("Tool authority is a separate choice");
        const source = readFileSync(new URL("./onboarding-features.tsx", import.meta.url), "utf8");
        expect(source).not.toMatch(/FakeChat|FakeLayout|OnboardingFooter|FeaturePageName/);
    });

    it("retains the seen marker and start event and passes through completion", () => {
        const complete = vi.fn();
        const tree = OnboardingFeatures({ onComplete: complete });
        Harness.effects[0]();
        expect(Harness.meta).toHaveBeenCalledWith(
            {},
            { oref: "client:synthetic-client", meta: { "onboarding:lastversion": CurrentOnboardingVersion } }
        );
        expect(Harness.event).toHaveBeenCalledWith(
            {},
            { event: "onboarding:start", props: { "onboarding:version": CurrentOnboardingVersion } }
        );
        tree.props.onComplete();
        expect(complete).toHaveBeenCalledOnce();
    });

    it("matches the package marker to a distinct current card and preserves historical labels", () => {
        const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
        const current = UpgradeOnboardingVersions.at(-1);
        expect(CurrentOnboardingVersion).toBe(`v${pkg.version}`);
        expect(current.version).toBe(CurrentOnboardingVersion);
        const historical = UpgradeOnboardingVersions.find((version) => version.version === "v0.15.7");
        expect(historical).toBeTruthy();
        expect(historical.nextText).toContain(CurrentOnboardingVersion);
        expect(current.prevText).toContain("v0.15.7");
        expect(renderToStaticMarkup(current.content())).not.toBe(renderToStaticMarkup(historical.content()));
        expect(renderToStaticMarkup(historical.content())).not.toContain("You are running");
    });

    it("contains no reachable cultivation promises or retired CroweLM website links", () => {
        const html = UpgradeOnboardingVersions.map((version) => renderToStaticMarkup(version.content())).join(" ");
        expect(html).not.toMatch(/grow operations|grow ops|cultivation|crowelm\.com/i);
    });

    it("opens current news, navigates historical cards and only records upgrade dismissal", () => {
        const current = patch();
        expect(JSON.stringify(current)).toContain(CurrentOnboardingVersion);
        footer(current).props.onPrev();
        expect(JSON.stringify(patch())).toContain("Hypheus ");
        expect(footer(patch()).props.nextText).toContain(CurrentOnboardingVersion);
        footer(patch()).props.onClose();
        expect(Harness.meta).toHaveBeenCalledWith(
            {},
            { oref: "client:synthetic-client", meta: { "onboarding:lastversion": CurrentOnboardingVersion } }
        );
        expect(Harness.set).toHaveBeenCalledWith("upgrade", false);
        Harness.meta.mockClear();
        footer(patch(true)).props.onClose();
        expect(Harness.meta).not.toHaveBeenCalled();
        expect(Harness.pop).toHaveBeenCalledOnce();
    });

    it("shows current cards for older users and nothing for already-seen versions", () => {
        Harness.client.meta["onboarding:lastversion"] = "v0.15.7";
        expect(UpgradeOnboardingModal().type).toBe(UpgradeOnboardingPatch);
        Harness.client.meta["onboarding:lastversion"] = CurrentOnboardingVersion;
        expect(UpgradeOnboardingModal()).toBeNull();
        Harness.effects.at(-1)();
        expect(Harness.set).toHaveBeenCalledWith("upgrade", false);
        Harness.client.meta["onboarding:lastversion"] = "v0.1.0";
        expect(UpgradeOnboardingModal().type).toBe(UpgradeOnboardingMinor);
    });

    it("lets older installs open their workspace directly without a second welcome", () => {
        const tree = nodes(UpgradeOnboardingMinor());
        const features = tree.find((node) => node.type === OnboardingFeatures);
        expect(features).toBeTruthy();
        features.props.onComplete();
        expect(Harness.set).toHaveBeenCalledWith("upgrade", false);
        expect(Harness.meta).toHaveBeenCalledWith(
            {},
            { oref: "client:synthetic-client", meta: { "onboarding:lastversion": CurrentOnboardingVersion } }
        );
    });
});
