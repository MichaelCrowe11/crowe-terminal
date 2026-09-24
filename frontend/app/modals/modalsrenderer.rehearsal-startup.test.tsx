// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Fakes = vi.hoisted(() => ({
    getEnv: vi.fn(),
    useAtomValue: vi.fn(),
    useAtom: vi.fn(),
    newOpen: vi.fn(),
    upgradeOpen: vi.fn(),
    storeSet: vi.fn(),
    effects: [] as (() => void)[],
    hookOrder: [] as string[],
}));
vi.mock("react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("react")>()),
    useEffect: (effect: () => void) => {
        Fakes.hookOrder.push("effect");
        Fakes.effects.push(effect);
    },
}));
vi.mock("jotai", () => ({ useAtomValue: Fakes.useAtomValue, useAtom: Fakes.useAtom }));
vi.mock("@/app/onboarding/onboarding", () => ({ NewInstallOnboardingModal: () => null }));
vi.mock("@/app/onboarding/onboarding-upgrade", () => ({ UpgradeOnboardingModal: () => null }));
vi.mock("@/app/onboarding/onboarding-common", () => ({ CurrentOnboardingVersion: "v2.0.0" }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: "client" }) } }));
vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { set: Fakes.storeSet } }));
vi.mock("@/store/global", () => ({ atoms: { modalOpen: "modalOpen" }, globalPrimaryTabStartup: true }));
vi.mock("@/store/modalmodel", () => ({
    modalsModel: { newInstallOnboardingOpen: "new", upgradeOnboardingOpen: "upgrade", modalsAtom: "modals" },
}));
vi.mock("./modalregistry", () => ({ getModalComponent: vi.fn() }));

async function runAutomaticEffects(tosagreed: boolean) {
    const client = Object.freeze({ tosagreed, meta: Object.freeze({ "onboarding:lastversion": "v0.0.0" }) });
    Fakes.useAtomValue.mockImplementation(() => {
        Fakes.hookOrder.push("client");
        return client;
    });
    const { ModalsRenderer } = await import("./modalsrenderer");
    ModalsRenderer();
    expect(Fakes.hookOrder).toEqual(["client", "new", "upgrade", "modals", "effect", "effect", "effect"]);
    expect(Fakes.effects).toHaveLength(3);
    for (const effect of Fakes.effects) effect();
    expect(client).toEqual({ tosagreed, meta: { "onboarding:lastversion": "v0.0.0" } });
    expect(Fakes.storeSet).toHaveBeenCalledExactlyOnceWith("modalOpen", false);
}

describe("automatic onboarding offline rehearsal deferral", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        Fakes.effects.length = 0;
        Fakes.hookOrder.length = 0;
        vi.stubGlobal("window", { api: { getEnv: Fakes.getEnv } });
        Fakes.useAtom.mockImplementation((atom) => {
            Fakes.hookOrder.push(atom);
            if (atom === "new") return [false, Fakes.newOpen];
            if (atom === "upgrade") return [false, Fakes.upgradeOpen];
            return [[], vi.fn()];
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([false, true])("defers both effects without acceptance/version mutations (tosagreed=%s)", async (agreed) => {
        Fakes.getEnv.mockReturnValue("1");
        await runAutomaticEffects(agreed);
        expect(Fakes.newOpen).not.toHaveBeenCalled();
        expect(Fakes.upgradeOpen).not.toHaveBeenCalled();
        expect(Fakes.getEnv).toHaveBeenCalledWith("CROWE_REHEARSAL_OFFLINE");
    });

    it.each([undefined, null, "", "0", "true", "01", " 1"].flatMap((flag) => [false, true].map((agreed) => ({ flag, agreed }))))(
        "preserves normal effects for $flag, tosagreed=$agreed",
        async ({ flag, agreed }) => {
            Fakes.getEnv.mockReturnValue(flag);
            await runAutomaticEffects(agreed);
            expect(Fakes.newOpen).toHaveBeenCalledTimes(agreed ? 0 : 1);
            expect(Fakes.upgradeOpen).toHaveBeenCalledTimes(agreed ? 1 : 0);
            expect(agreed ? Fakes.upgradeOpen : Fakes.newOpen).toHaveBeenCalledWith(true);
        }
    );
});
