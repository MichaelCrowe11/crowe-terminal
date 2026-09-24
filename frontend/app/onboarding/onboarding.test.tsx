// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const Harness = vi.hoisted(() => ({
    state: [] as any[],
    index: 0,
    enabled: false,
    tosagreed: true,
    page: vi.fn(),
    agree: vi.fn(),
}));
vi.mock("react", async (load) => ({
    ...(await load<typeof import("react")>()),
    useState: (initial: any) => {
        const index = Harness.index++;
        if (!(index in Harness.state)) Harness.state[index] = typeof initial === "function" ? initial() : initial;
        return [
            Harness.state[index],
            (value: any) => {
                Harness.state[index] = value;
            },
        ];
    },
    useRef: (initial: any) => {
        const index = Harness.index++;
        if (!(index in Harness.state)) Harness.state[index] = { current: initial };
        return Harness.state[index];
    },
}));
vi.mock("jotai", () => ({
    atom: (value: any) => value,
    useAtomValue: () => ({ tosagreed: Harness.tosagreed }),
    useSetAtom: () => Harness.page,
}));
vi.mock("@/app/asset/logo.svg", () => ({ default: "svg" }));
vi.mock("@/app/element/button", () => ({ Button: "button" }));
vi.mock("@/app/modals/modal", () => ({ FlexiModal: "div" }));
vi.mock("@/app/onboarding/onboarding-features", () => ({ OnboardingFeatures: "div" }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: {} }) } }));
vi.mock("@/app/store/global", () => ({ useSettingsKeyAtom: () => Harness.enabled }));
vi.mock("@/app/store/keymodel", () => ({}));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: {} }));
vi.mock("@/app/store/wos", () => ({}));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/store/services", () => ({ ClientService: { AgreeTos: Harness.agree } }));
vi.mock("@/util/util", () => ({ fireAndForget: (fn: () => void) => fn() }));
vi.mock("overlayscrollbars-react", () => ({ OverlayScrollbarsComponent: "div" }));

import { InitPage } from "./onboarding";

function nodes(tree: any): any[] {
    if (!tree || typeof tree !== "object") return [];
    return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
}
function render(update: (value: boolean) => Promise<void>) {
    Harness.index = 0;
    return nodes(InitPage({ isCompact: false, telemetryUpdateFn: update }));
}
function continueButton(tree: any[]) {
    return tree.find((node) => node.type === "button" && node.props.children === "Continue");
}

describe("Usage analytics consent", () => {
    beforeEach(() => {
        Harness.state = [];
        Harness.enabled = false;
        Harness.tosagreed = true;
        vi.clearAllMocks();
    });

    it("retains first-install terms completion independently of optional analytics", () => {
        Harness.tosagreed = false;
        const update = vi.fn();
        continueButton(render(update)).props.onClick();
        expect(Harness.agree).toHaveBeenCalledOnce();
        expect(Harness.page).toHaveBeenCalledWith("features");
        expect(update).not.toHaveBeenCalled();
    });

    it.each([true, false])(
        "continues to the same page for consent=%s without touching operator visibility",
        (enabled) => {
            Harness.enabled = enabled;
            const update = vi.fn();
            continueButton(render(update)).props.onClick();
            expect(Harness.page).toHaveBeenCalledExactlyOnceWith("features");
            expect(update).not.toHaveBeenCalled();
        }
    );

    it("serializes writes and blocks Continue while pending", async () => {
        let complete: () => void;
        const update = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                })
        );
        const initial = render(update);
        const input = initial.find((node) => node.type === "input");
        input.props.onChange({ target: { checked: true } });
        input.props.onChange({ target: { checked: false } });
        continueButton(initial).props.onClick();
        expect(Harness.page).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledExactlyOnceWith(true);
        expect(continueButton(render(update)).props.disabled).toBe(true);
        complete();
        await Promise.resolve();
        const updated = render(update);
        expect(updated.find((node) => node.type === "input").props.checked).toBe(true);
        expect(continueButton(updated).props.disabled).toBe(false);
    });

    it("retains confirmed consent and exposes a retryable failure", async () => {
        const update = vi.fn().mockRejectedValue(new Error("synthetic failure"));
        render(update)
            .find((node) => node.type === "input")
            .props.onChange({ target: { checked: true } });
        await Promise.resolve();
        const failed = render(update);
        expect(failed.find((node) => node.type === "input").props.checked).toBe(false);
        expect(failed.find((node) => node.props.id === "crowe-consent-status").props.children).toContain(
            "Could not save"
        );
        expect(continueButton(failed).props.disabled).toBe(true);
        continueButton(failed).props.onClick();
        expect(Harness.page).not.toHaveBeenCalled();
        update.mockResolvedValueOnce(undefined);
        failed.find((node) => node.type === "input").props.onChange({ target: { checked: true } });
        await Promise.resolve();
        const recovered = render(update);
        expect(recovered.find((node) => node.type === "input").props.checked).toBe(true);
        expect(continueButton(recovered).props.disabled).toBe(false);
        continueButton(recovered).props.onClick();
        expect(Harness.page).toHaveBeenCalledWith("features");
    });
});
