// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the source function and its real outer rejection handler without evaluating
// module imports, Electron lifecycle registrations, or host environment access.
function startupSource(): string {
    const source = ts.createSourceFile(
        "emain.ts",
        readFileSync(new URL("./emain.ts", import.meta.url), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    const functions = source.statements.filter(
        (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "appMain"
    );
    const invocations = source.statements.filter((node): node is ts.ExpressionStatement => {
        if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
        const method = node.expression.expression;
        if (!ts.isPropertyAccessExpression(method) || method.name.text !== "catch") return false;
        const call = method.expression;
        return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "appMain";
    });
    expect(functions).toHaveLength(1);
    expect(invocations).toHaveLength(1);
    const result = ts.transpileModule(`${functions[0].getText(source)}\n${invocations[0].getText(source)}`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        reportDiagnostics: true,
    });
    expect(result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
    return result.outputText;
}

const StartupSource = startupSource();

function startupHarness(flag?: string) {
    const quit = vi.fn();
    const setUserConfirmedQuit = vi.fn();
    const log = vi.fn();
    const whenReady = vi.fn().mockResolvedValue(undefined);
    const getWaveSrvReady = vi.fn().mockResolvedValue(true);
    const runWaveSrv = vi.fn().mockResolvedValue(true);
    const startFoundryBridge = vi.fn().mockResolvedValue(false);
    const getFullConfig = vi.fn().mockResolvedValue({ settings: {} });
    const timer = vi.fn();
    const handlers = vi.fn();
    const sandbox = {
        process: { env: { CROWE_REHEARSAL_OFFLINE: flag } },
        console: { log, warn: vi.fn() },
        electronApp: {
            requestSingleInstanceLock: vi.fn().mockReturnValue(true),
            disableHardwareAcceleration: vi.fn(),
            on: vi.fn(),
            whenReady,
            quit,
        },
        electron: { session: { defaultSession: {} }, powerMonitor: { on: vi.fn() } },
        getLaunchSettings: vi.fn().mockReturnValue({}),
        setUserConfirmedQuit,
        runWaveSrv,
        handleWSEvent: vi.fn(),
        getWaveSrvReady,
        startFoundryBridge,
        configureAuthKeyRequestInjection: vi.fn(),
        initIpcHandlers: handlers,
        sleep: vi.fn().mockResolvedValue(undefined),
        initElectronWshClient: vi.fn(),
        initElectronWshrpc: vi.fn(),
        ElectronWshClient: {},
        AuthKey: "synthetic-only",
        initMenuEventSubscriptions: vi.fn(),
        RpcApi: { GetFullConfigCommand: getFullConfig, NotifySystemResumeCommand: vi.fn() },
        checkIfRunningUnderARM64Translation: vi.fn(),
        confirmQuit: true,
        ensureHotSpareTab: vi.fn(),
        relaunchBrowserWindows: vi.fn().mockResolvedValue(undefined),
        setTimeout: timer,
        runActiveTimer: vi.fn(),
        sendDisplaysTDataEvent: vi.fn(),
        makeAndSetAppMenu: vi.fn(),
        makeDockTaskbar: vi.fn(),
        configureAutoUpdater: vi.fn().mockResolvedValue(undefined),
        setGlobalIsStarting: vi.fn(),
        setMaxTabCacheSize: vi.fn(),
        getAllWaveWindows: vi.fn().mockReturnValue([]),
        getQuakeWindow: vi.fn(),
        fireAndForget: vi.fn(),
        createNewWaveWindow: vi.fn(),
        registerGlobalHotkey: vi.fn(),
        initGlobalHotkeyEventSubscription: vi.fn(),
    };
    return {
        sandbox,
        quit,
        setUserConfirmedQuit,
        log,
        whenReady,
        runWaveSrv,
        getWaveSrvReady,
        startFoundryBridge,
        getFullConfig,
        timer,
        handlers,
        run: () => runInNewContext(StartupSource, sandbox, { timeout: 1000 }) as Promise<void>,
    };
}

describe("actual appMain offline rehearsal failure propagation", () => {
    it("reaches the real outer shutdown catch before waiting for a readiness signal that never arrives", async () => {
        const h = startupHarness("1");
        const failure = new Error("Offline rehearsal requires WAVETERM_NOPING=1");
        h.runWaveSrv.mockRejectedValue(failure);
        h.getWaveSrvReady.mockImplementation(() => new Promise(() => {}));

        await h.run();

        expect(h.runWaveSrv).toHaveBeenCalledExactlyOnceWith(h.sandbox.handleWSEvent);
        expect(h.log).toHaveBeenCalledWith("appMain error", failure);
        expect(h.setUserConfirmedQuit).toHaveBeenCalledExactlyOnceWith(true);
        expect(h.quit).toHaveBeenCalledTimes(1);
        expect(h.setUserConfirmedQuit.mock.invocationCallOrder[0]).toBeLessThan(h.quit.mock.invocationCallOrder[0]);
        expect(h.getWaveSrvReady).not.toHaveBeenCalled();
        expect(h.startFoundryBridge).not.toHaveBeenCalled();
        expect(h.whenReady).not.toHaveBeenCalled();
        expect(h.handlers).not.toHaveBeenCalled();
        expect(h.getFullConfig).not.toHaveBeenCalled();
        expect(h.timer).not.toHaveBeenCalled();
    });

    it.each([undefined, "", "0", "true", "01", " 1", "1 "])("preserves ordinary rejection/readiness behavior for %s", async (flag) => {
        const h = startupHarness(flag);
        const failure = new Error("synthetic ordinary spawn failure");
        h.runWaveSrv.mockRejectedValue(failure);
        let ready: (value: boolean) => void;
        let entered: () => void;
        const readiness = new Promise<boolean>((resolve) => { ready = resolve; });
        const waitingForReady = new Promise<void>((resolve) => { entered = resolve; });
        h.getWaveSrvReady.mockImplementation(() => {
            entered();
            return readiness;
        });
        const pending = h.run();
        await waitingForReady;
        expect(h.getWaveSrvReady).toHaveBeenCalledTimes(1);
        expect(h.quit).not.toHaveBeenCalled();
        expect(h.setUserConfirmedQuit).not.toHaveBeenCalled();
        expect(h.log).toHaveBeenCalledWith(failure.toString());
        expect(h.startFoundryBridge).not.toHaveBeenCalled();
        ready(true);
        await pending;
        expect(h.startFoundryBridge).toHaveBeenCalledTimes(1);
        expect(h.handlers).toHaveBeenCalledTimes(1);
        expect(h.quit).not.toHaveBeenCalled();
        expect(h.log).not.toHaveBeenCalledWith("appMain error", expect.anything());
    });

    it("preserves successful rehearsal startup with mocked boundaries", async () => {
        const h = startupHarness("1");
        await h.run();
        expect(h.getWaveSrvReady).toHaveBeenCalledTimes(1);
        expect(h.whenReady).toHaveBeenCalledTimes(1);
        expect(h.handlers).toHaveBeenCalledTimes(1);
        expect(h.getFullConfig).toHaveBeenCalledTimes(1);
        expect(h.sandbox.setGlobalIsStarting).toHaveBeenCalledWith(false);
        expect(h.quit).not.toHaveBeenCalled();
        expect(h.log).not.toHaveBeenCalledWith("appMain error", expect.anything());
    });
});
