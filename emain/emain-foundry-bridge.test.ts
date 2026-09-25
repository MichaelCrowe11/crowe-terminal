// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Fakes = vi.hoisted(() => ({
    fetch: vi.fn(),
    existsSync: vi.fn(),
    homedir: vi.fn(),
    spawn: vi.fn(),
}));

// AuthKey's real module imports Electron startup dependencies. Never evaluate it in these tests.
vi.mock("./authkey", () => ({ AuthKey: "synthetic-unit-test-auth" }));
vi.mock("electron", () => ({}));
vi.mock("node:fs", () => ({ existsSync: Fakes.existsSync }));
vi.mock("node:os", () => ({ homedir: Fakes.homedir }));
vi.mock("node:child_process", () => ({ spawn: Fakes.spawn }));

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
    });
}

describe("Foundry startup opt-in guard", () => {
    let envDescriptor: PropertyDescriptor;
    let env: Record<string, string>;
    let envReads: string[];

    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        vi.useFakeTimers();
        vi.stubGlobal("fetch", Fakes.fetch);
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        // Retain only the descriptor for restoration; never inspect or spread the real environment.
        envDescriptor = Object.getOwnPropertyDescriptor(process, "env");
        env = {};
        envReads = [];
        Object.defineProperty(process, "env", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: new Proxy(env, {
                get(target, name: string) {
                    envReads.push(name);
                    return target[name];
                },
            }),
        });
        Fakes.fetch.mockResolvedValue({ ok: true });
        Fakes.homedir.mockReturnValue("/synthetic-home");
        Fakes.existsSync.mockReturnValue(false);
        Fakes.spawn.mockImplementation(() => {
            throw new Error("unexpected fake spawn");
        });
    });

    afterEach(() => {
        Object.defineProperty(process, "env", envDescriptor);
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("returns false for exactly 1 before probe, discovery, or spawn", async () => {
        env.CROWE_FOUNDRY_DISABLED = "1";
        const bridge = await import("./emain-foundry-bridge");
        envReads.length = 0;

        const result = await bridge.startFoundryBridge();
        const startupEnvReads = [...envReads];

        expect(result).toBe(false);
        expect(bridge.isBridgeReady()).toBe(false);
        expect(startupEnvReads.filter((name) => name.startsWith("CROWE_"))).toEqual(["CROWE_FOUNDRY_DISABLED"]);
        expect(Fakes.fetch).not.toHaveBeenCalled();
        expect(Fakes.existsSync).not.toHaveBeenCalled();
        expect(Fakes.homedir).not.toHaveBeenCalled();
        expect(Fakes.spawn).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([undefined, "0", "true", "01", " 1"])("retains external bridge probing for %s", async (flag) => {
        if (flag != null) env.CROWE_FOUNDRY_DISABLED = flag;
        const bridge = await import("./emain-foundry-bridge");

        expect(await bridge.startFoundryBridge()).toBe(true);
        expect(bridge.isBridgeReady()).toBe(true);
        expect(Fakes.fetch).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:8011/healthz", {
            signal: expect.any(AbortSignal),
            redirect: "error",
        });
        expect(Fakes.existsSync).not.toHaveBeenCalled();
        expect(Fakes.spawn).not.toHaveBeenCalled();
    });

    it.each([undefined, "0"])("retains discovery and child startup for %s, with guard before cached child", async (flag) => {
        if (flag != null) env.CROWE_FOUNDRY_DISABLED = flag;
        env.CROWE_FOUNDRY_PATH = "/synthetic-foundry";
        env.CROWE_FOUNDRY_PYTHON = "/synthetic-python";
        Fakes.existsSync.mockReturnValue(true);
        Fakes.fetch.mockReset();
        for (let i = 0; i < 4; i++) Fakes.fetch.mockResolvedValueOnce({ ok: false });
        Fakes.fetch.mockResolvedValue({ ok: true });
        const child = fakeChild();
        Fakes.spawn.mockImplementation((_bin, args) => {
            if (args[0] === "-c") {
                const probe = fakeChild();
                queueMicrotask(() => {
                    probe.stdout.emit("data", "3 12\n");
                    probe.emit("close", 0);
                });
                return probe;
            }
            return child;
        });
        const bridge = await import("./emain-foundry-bridge");
        const startup = bridge.startFoundryBridge();
        await vi.advanceTimersByTimeAsync(1000);

        expect(await startup).toBe(true);
        expect(Fakes.existsSync).toHaveBeenCalledExactlyOnceWith("/synthetic-foundry/cli/openai_bridge.py");
        expect(Fakes.spawn).toHaveBeenCalledTimes(2);
        expect(Fakes.spawn).toHaveBeenNthCalledWith(2, "/synthetic-python", ["-m", "cli.openai_bridge"], {
            cwd: "/synthetic-foundry",
            env: expect.objectContaining({
                CROWE_BRIDGE_HOST: "127.0.0.1",
                CROWE_BRIDGE_PORT: "8011",
                PYTHONPATH: "/synthetic-foundry",
                WAVETERM_AUTH_KEY: "synthetic-unit-test-auth",
            }),
            stdio: ["ignore", "pipe", "pipe"],
        });
        expect(bridge.isBridgeReady()).toBe(true);
        expect(vi.getTimerCount()).toBe(0);

        vi.clearAllMocks();
        env.CROWE_FOUNDRY_DISABLED = "1";
        expect(await bridge.startFoundryBridge()).toBe(false);
        expect(Fakes.fetch).not.toHaveBeenCalled();
        expect(Fakes.existsSync).not.toHaveBeenCalled();
        expect(Fakes.homedir).not.toHaveBeenCalled();
        expect(Fakes.spawn).not.toHaveBeenCalled();
        expect(child.kill).not.toHaveBeenCalled();
        // A startup opt-out is not a shutdown API for an already-running child.
        expect(bridge.isBridgeReady()).toBe(true);
        bridge.stopFoundryBridge();
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });
});
