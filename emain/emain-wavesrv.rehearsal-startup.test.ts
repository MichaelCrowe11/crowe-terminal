// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Fakes = vi.hoisted(() => ({ spawn: vi.fn(), quit: vi.fn() }));
vi.mock("electron", () => ({ app: { quit: Fakes.quit } }));
vi.mock("node:child_process", () => ({ spawn: Fakes.spawn }));
vi.mock("readline", () => ({ createInterface: () => new EventEmitter() }));
vi.mock("../frontend/util/endpoints", () => ({
    WebServerEndpointVarName: "WAVE_SERVER_WEB_ENDPOINT",
    WSServerEndpointVarName: "WAVE_SERVER_WS_ENDPOINT",
}));
vi.mock("./authkey", () => ({
    AuthKey: "synthetic-unit-test-auth",
    WaveAuthKeyEnv: "WAVETERM_AUTH_KEY",
    setWaveSrvFrontendKey: (env: NodeJS.ProcessEnv) => {
        env.WAVETERM_FRONTEND_KEY = "synthetic-frontend-key";
    },
}));
vi.mock("./emain-activity", () => ({ setForceQuit: vi.fn(), setUserConfirmedQuit: vi.fn() }));
vi.mock("./updater", () => ({ updater: null }));
vi.mock("./emain-platform", () => ({
    getElectronAppResourcesPath: () => "/synthetic/resources",
    getElectronAppUnpackedBasePath: () => "/synthetic/app",
    getWaveConfigDir: () => "/synthetic/config",
    getWaveDataDir: () => "/synthetic/data",
    getWaveSrvCwd: () => "/synthetic/cwd",
    getWaveSrvPath: () => "/synthetic/wavesrv",
    getXdgCurrentDesktop: () => null,
    WaveConfigHomeVarName: "WAVETERM_CONFIG_HOME",
    WaveDataHomeVarName: "WAVETERM_DATA_HOME",
}));
vi.mock("./emain-util", () => ({
    getElectronExecPath: () => "/synthetic/electron",
    WaveAppElectronExecPath: "WAVETERM_ELECTRON",
    WaveAppPathVarName: "WAVETERM_APP_PATH",
    WaveAppResourcesPathVarName: "WAVETERM_RESOURCES",
}));

const SafetyFlags = ["CROWE_FOUNDRY_DISABLED", "CROWE_AGENT_DISABLED", "WAVETERM_NOPING"];

describe("backend offline rehearsal startup", () => {
    let descriptor: PropertyDescriptor;
    let env: Record<string, string>;
    let child: EventEmitter;

    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        vi.spyOn(console, "log").mockImplementation(() => {});
        descriptor = Object.getOwnPropertyDescriptor(process, "env");
        env = { WAVETERM_DEV: "1", WAVETERM_DEV_VITE: "1", SYNTHETIC_KEEP: "unchanged" };
        Object.defineProperty(process, "env", { ...descriptor, value: env });
        child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
        Fakes.spawn.mockReturnValue(child);
    });

    afterEach(() => {
        Object.defineProperty(process, "env", descriptor);
        vi.restoreAllMocks();
    });

    it("strips only child development overrides and preserves parent environment", async () => {
        env.CROWE_REHEARSAL_OFFLINE = "1";
        for (const name of SafetyFlags) env[name] = "1";
        const before = { ...env };
        const { runWaveSrv } = await import("./emain-wavesrv");
        const pending = runWaveSrv(vi.fn());
        child.emit("spawn");
        await expect(pending).resolves.toBe(true);
        expect(Fakes.spawn).toHaveBeenCalledTimes(1);
        const childEnv = Fakes.spawn.mock.calls[0][1].env;
        expect(childEnv).not.toBe(env);
        expect(childEnv).not.toHaveProperty("WAVETERM_DEV");
        expect(childEnv).not.toHaveProperty("WAVETERM_DEV_VITE");
        expect(childEnv.SYNTHETIC_KEEP).toBe("unchanged");
        expect(childEnv.WAVETERM_FRONTEND_KEY).toBe("synthetic-frontend-key");
        expect(env).not.toHaveProperty("WAVETERM_FRONTEND_KEY");
        for (const name of SafetyFlags) expect(childEnv[name]).toBe("1");
        expect(env).toEqual(before);
        expect(process.env).toBe(env);
    });

    it.each(SafetyFlags.flatMap((name) => [undefined, "0", "true", "01", " 1"].map((value) => ({ name, value }))))(
        "rejects before spawn when $name is $value",
        async ({ name, value }) => {
            env.CROWE_REHEARSAL_OFFLINE = "1";
            for (const flag of SafetyFlags) env[flag] = "1";
            if (value == null) delete env[name];
            else env[name] = value;
            const before = { ...env };
            const { runWaveSrv } = await import("./emain-wavesrv");
            await expect(runWaveSrv(vi.fn())).rejects.toThrow(`${name}=1`);
            expect(Fakes.spawn).not.toHaveBeenCalled();
            expect(env).toEqual(before);
        }
    );

    it.each([undefined, "", "0", "true", "01", " 1"])("retains normal startup for %s", async (flag) => {
        if (flag != null) env.CROWE_REHEARSAL_OFFLINE = flag;
        const { runWaveSrv } = await import("./emain-wavesrv");
        const pending = runWaveSrv(vi.fn());
        child.emit("spawn");
        await expect(pending).resolves.toBe(true);
        expect(Fakes.spawn.mock.calls[0][1].env).toMatchObject(env);
        expect(Fakes.spawn.mock.calls[0][1].env.WAVETERM_DEV).toBe("1");
        expect(Fakes.spawn.mock.calls[0][1].env.WAVETERM_DEV_VITE).toBe("1");
    });
});
