// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Fakes = vi.hoisted(() => ({
    getEnv: vi.fn(),
    eventSource: vi.fn(),
    fetch: vi.fn(),
    existsSync: vi.fn(),
    spawn: vi.fn(),
}));

vi.mock("electron", () => ({}));
vi.mock("node:fs", () => ({ existsSync: Fakes.existsSync }));
vi.mock("node:child_process", () => ({ spawn: Fakes.spawn }));

describe("Telemetry startup opt-in guard", () => {
    let source: { onopen: () => void; onerror: () => void; onmessage: (event: { data: string }) => void };

    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        // Exercise the real getEnv utility's preload route without importing Electron or inspecting host values.
        vi.stubGlobal("window", { api: { getEnv: Fakes.getEnv } });
        vi.stubGlobal("fetch", Fakes.fetch);
        source = { onopen: null, onerror: null, onmessage: null };
        Fakes.eventSource.mockImplementation(function () {
            return source;
        });
        vi.stubGlobal("EventSource", Fakes.eventSource);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("does not construct an EventSource for exactly 1", async () => {
        Fakes.getEnv.mockReturnValue("1");
        const { TelemetryModel } = await import("./telemetry-model");
        const { globalStore } = await import("@/app/store/jotaiStore");
        const model = TelemetryModel.getInstance();

        model.connect();
        model.connect();

        expect(Fakes.getEnv).toHaveBeenCalledWith("CROWE_FOUNDRY_DISABLED");
        expect(Fakes.eventSource).not.toHaveBeenCalled();
        expect(Fakes.fetch).not.toHaveBeenCalled();
        expect(Fakes.existsSync).not.toHaveBeenCalled();
        expect(Fakes.spawn).not.toHaveBeenCalled();
        expect(model.source).toBeNull();
        expect(globalStore.get(model.liveAtom)).toBe(false);
    });

    it.each([undefined, null, "0", "", "true", "01", " 1"])("preserves stream setup and handlers for %s", async (flag) => {
        Fakes.getEnv.mockReturnValue(flag);
        const { TelemetryModel } = await import("./telemetry-model");
        const { globalStore } = await import("@/app/store/jotaiStore");
        const model = TelemetryModel.getInstance();
        const onStreamEvent = vi.spyOn(model, "onStreamEvent");

        model.connect();
        model.connect();

        expect(Fakes.getEnv).toHaveBeenCalledWith("CROWE_FOUNDRY_DISABLED");
        expect(Fakes.eventSource).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:8011/crowe/telemetry/stream");
        expect(model.source).toBe(source);
        source.onopen();
        expect(globalStore.get(model.liveAtom)).toBe(true);
        source.onerror();
        expect(globalStore.get(model.liveAtom)).toBe(false);
        source.onmessage({ data: '{"type":"ready"}' });
        expect(onStreamEvent).toHaveBeenCalledWith('{"type":"ready"}');
        expect(globalStore.get(model.liveAtom)).toBe(true);
        expect(Fakes.fetch).not.toHaveBeenCalled();
    });

    it("can connect after an opt-out is removed", async () => {
        Fakes.getEnv.mockReturnValue("1");
        const { TelemetryModel } = await import("./telemetry-model");
        const model = TelemetryModel.getInstance();
        model.connect();
        expect(Fakes.eventSource).not.toHaveBeenCalled();

        Fakes.getEnv.mockReturnValue("0");
        model.connect();
        expect(Fakes.eventSource).toHaveBeenCalledTimes(1);
    });

    it("retains no-EventSource behavior", async () => {
        vi.stubGlobal("EventSource", undefined);
        const { TelemetryModel } = await import("./telemetry-model");
        const model = TelemetryModel.getInstance();

        expect(() => model.connect()).not.toThrow();
        expect(model.source).toBeNull();
    });

    it("waits for observed output before displaying a phase", async () => {
        const { TelemetryModel } = await import("./telemetry-model");
        const { globalStore } = await import("@/app/store/jotaiStore");
        const model = TelemetryModel.getInstance();
        model.onSubmit();
        expect(globalStore.get(model.statusAtom)).toBe("running");
        expect(globalStore.get(model.phaseAtom)).toBe("idle");
        expect(Fakes.eventSource).not.toHaveBeenCalled();
        model.liveTool("read-file");
        model.liveReasoning(12);
        expect(globalStore.get(model.phaseAtom)).toBe("reasoning");
        expect(globalStore.get(model.currentToolAtom)).toBe("");
        model.liveTool("search");
        model.liveToken(12);
        expect(globalStore.get(model.phaseAtom)).toBe("responding");
        expect(globalStore.get(model.currentToolAtom)).toBe("");
        model.onSubmit();
        model.liveTool("read-file");
        model.recordChars(12);
        expect(globalStore.get(model.currentToolAtom)).toBe("");
        expect(globalStore.get(model.phaseAtom)).toBe("responding");
    });

    it("retains constructor failure handling", async () => {
        Fakes.eventSource.mockImplementation(function () {
            throw new Error("synthetic constructor failure");
        });
        const { TelemetryModel } = await import("./telemetry-model");
        const model = TelemetryModel.getInstance();

        expect(() => model.connect()).not.toThrow();
        expect(Fakes.eventSource).toHaveBeenCalledTimes(1);
        expect(model.source).toBeNull();
    });
});
