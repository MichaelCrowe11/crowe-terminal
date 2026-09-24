// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CroweAccountButton, CroweAccountSetup } from "./croweaccount";
import {
    CroweAccountMode,
    CroweAccountModel,
    CroweDeviceUrl,
    isCroweAccountMode,
    sanitizeCroweAccountStatus,
} from "./croweaccount-model";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("@/app/store/global", () => ({ getApi: () => ({ openExternal }) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        CroweAuthStatusCommand: vi.fn(),
        CroweAuthStartCommand: vi.fn(),
        CroweAuthCancelCommand: vi.fn(),
        CroweAuthDisconnectCommand: vi.fn(),
    },
}));

const PendingStatus: CroweAuthStatus = {
    state: "pending",
    usercode: "ABCD-EFGH",
    expiresat: 1800000000000,
    verificationurl: "https://untrusted.example/device?device_code=fictional-device-secret",
    message: "fictional-message-secret",
};

function deferred<T>() {
    let resolve: (value: T) => void;
    let reject: (reason: Error) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function renderSetup(accountMode = true): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <CroweAccountSetup accountMode={accountMode} onUseAccount={() => {}} />
        </Provider>
    );
}

let model: CroweAccountModel;
beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    CroweAccountModel.resetInstance();
    model = CroweAccountModel.getInstance();
    vi.mocked(RpcApi.CroweAuthStatusCommand).mockResolvedValue({ state: "signedout" });
    vi.mocked(RpcApi.CroweAuthStartCommand).mockResolvedValue(PendingStatus);
    vi.mocked(RpcApi.CroweAuthCancelCommand).mockResolvedValue({ state: "signedout" });
    vi.mocked(RpcApi.CroweAuthDisconnectCommand).mockResolvedValue({ state: "signedout" });
});
afterEach(() => {
    CroweAccountModel.resetInstance();
    vi.useRealTimers();
});

describe("account polling", () => {
    it("checks status only while mounted and never starts authorization or opens a browser", async () => {
        vi.mocked(RpcApi.CroweAuthStatusCommand).mockResolvedValue(PendingStatus);
        expect(RpcApi.CroweAuthStatusCommand).not.toHaveBeenCalled();
        const unmount = model.mount();
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom).state).toBe("pending");
        expect(RpcApi.CroweAuthStatusCommand).toHaveBeenCalledTimes(1);
        expect(RpcApi.CroweAuthStartCommand).not.toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();
        unmount();
        unmount();
        await vi.advanceTimersByTimeAsync(10000);
        expect(RpcApi.CroweAuthStatusCommand).toHaveBeenCalledTimes(1);
    });

    it("shares one outstanding status request across mounts and slow replies", async () => {
        const poll = deferred<CroweAuthStatus>();
        vi.mocked(RpcApi.CroweAuthStatusCommand).mockReturnValueOnce(poll.promise);
        const first = model.mount();
        const second = model.mount();
        await vi.advanceTimersByTimeAsync(20000);
        expect(RpcApi.CroweAuthStatusCommand).toHaveBeenCalledTimes(1);
        first();
        poll.resolve({ state: "connected" });
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom).state).toBe("connected");
        await vi.advanceTimersByTimeAsync(2500);
        expect(RpcApi.CroweAuthStatusCommand).toHaveBeenCalledTimes(2);
        second();
    });

    it("ignores pre-unmount replies and resumes after remount without overlapping polls", async () => {
        const poll = deferred<CroweAuthStatus>();
        vi.mocked(RpcApi.CroweAuthStatusCommand).mockReturnValueOnce(poll.promise);
        const unmount = model.mount();
        await vi.advanceTimersByTimeAsync(0);
        unmount();
        model.mount();
        await vi.advanceTimersByTimeAsync(5000);
        expect(RpcApi.CroweAuthStatusCommand).toHaveBeenCalledTimes(1);
        poll.resolve({ state: "connected" });
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom).state).toBe("signedout");
        await vi.advanceTimersByTimeAsync(2500);
        expect(RpcApi.CroweAuthStatusCommand).toHaveBeenCalledTimes(2);
    });

    it("recovers after a status transport error without displaying raw exception text", async () => {
        vi.mocked(RpcApi.CroweAuthStatusCommand).mockRejectedValueOnce(new Error("fictional-access-secret"));
        model.mount();
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom).state).toBe("error");
        expect(renderSetup()).not.toContain("fictional-access-secret");
        await vi.advanceTimersByTimeAsync(2500);
        expect(globalStore.get(model.statusAtom).state).toBe("signedout");
    });
});

describe("account operations", () => {
    it("starts only on demand and opens only the fixed system-browser URL", async () => {
        model.mount();
        await model.start();
        expect(RpcApi.CroweAuthStartCommand).toHaveBeenCalledTimes(1);
        expect(openExternal).toHaveBeenCalledExactlyOnceWith(CroweDeviceUrl);
        expect(globalStore.get(model.statusAtom)).toEqual({
            state: "pending",
            usercode: "ABCD-EFGH",
            expiresat: PendingStatus.expiresat,
        });
        expect(renderSetup()).toContain("ABCD-EFGH");
    });

    it("prevents a status reply from overwriting a newer start", async () => {
        const poll = deferred<CroweAuthStatus>();
        vi.mocked(RpcApi.CroweAuthStatusCommand).mockReturnValueOnce(poll.promise);
        model.mount();
        await vi.advanceTimersByTimeAsync(0);
        await model.start();
        poll.resolve({ state: "signedout" });
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom).state).toBe("pending");
    });

    it("serializes cancel behind start, suppresses stale browser opening, and blocks duplicate clicks", async () => {
        const start = deferred<CroweAuthStatus>();
        vi.mocked(RpcApi.CroweAuthStartCommand).mockReturnValueOnce(start.promise);
        model.mount();
        const starting = model.start();
        await model.start();
        expect(globalStore.get(model.operationAtom)).toBe("start");
        expect(renderSetup()).toContain(">Cancel</button>");
        const canceling = model.cancel();
        await model.cancel();
        await vi.advanceTimersByTimeAsync(0);
        expect(RpcApi.CroweAuthStartCommand).toHaveBeenCalledTimes(1);
        expect(RpcApi.CroweAuthCancelCommand).not.toHaveBeenCalled();
        expect(RpcApi.CroweAuthStatusCommand).not.toHaveBeenCalled();
        start.resolve(PendingStatus);
        await starting;
        await canceling;
        expect(RpcApi.CroweAuthCancelCommand).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.statusAtom).state).toBe("signedout");
        expect(globalStore.get(model.operationAtom)).toBeNull();
        expect(openExternal).not.toHaveBeenCalled();
    });

    it("still cancels when the preceding start fails", async () => {
        const start = deferred<CroweAuthStatus>();
        vi.mocked(RpcApi.CroweAuthStartCommand).mockReturnValueOnce(start.promise);
        model.mount();
        const starting = model.start();
        const canceling = model.cancel();
        await vi.advanceTimersByTimeAsync(0);
        start.reject(new Error("fictional-refresh-secret"));
        await starting;
        await canceling;
        expect(RpcApi.CroweAuthCancelCommand).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.operationAtom)).toBeNull();
        expect(renderSetup()).not.toContain("fictional-refresh-secret");
    });

    it("does not open a browser or apply a mutation response after unmount", async () => {
        const start = deferred<CroweAuthStatus>();
        vi.mocked(RpcApi.CroweAuthStartCommand).mockReturnValueOnce(start.promise);
        const unmount = model.mount();
        const starting = model.start();
        await vi.advanceTimersByTimeAsync(0);
        unmount();
        start.resolve(PendingStatus);
        await starting;
        expect(openExternal).not.toHaveBeenCalled();
        expect(globalStore.get(model.statusAtom).state).not.toBe("pending");
        expect(globalStore.get(model.operationAtom)).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("disconnects without allowing an older connected poll to restore the session", async () => {
        const poll = deferred<CroweAuthStatus>();
        vi.mocked(RpcApi.CroweAuthStatusCommand).mockReturnValueOnce(poll.promise);
        model.applyStatus({ state: "connected" });
        model.mount();
        await vi.advanceTimersByTimeAsync(0);
        await model.disconnect();
        poll.resolve({ state: "connected" });
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom).state).toBe("signedout");
        expect(RpcApi.CroweAuthDisconnectCommand).toHaveBeenCalledTimes(1);
        expect(openExternal).not.toHaveBeenCalled();
    });

    it("reconnects after an invalidated session is reported by status without auto-starting", async () => {
        vi.mocked(RpcApi.CroweAuthStatusCommand)
            .mockResolvedValueOnce({ state: "connected" })
            .mockResolvedValueOnce({ state: "expired" });
        model.mount();
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom).state).toBe("connected");
        await vi.advanceTimersByTimeAsync(2500);
        expect(globalStore.get(model.statusAtom).state).toBe("expired");
        expect(renderSetup()).toContain("Retry connection");
        expect(RpcApi.CroweAuthStartCommand).not.toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();
        await model.start();
        expect(globalStore.get(model.statusAtom).state).toBe("pending");
        expect(openExternal).toHaveBeenCalledExactlyOnceWith(CroweDeviceUrl);
        vi.mocked(RpcApi.CroweAuthStatusCommand).mockResolvedValue({ state: "connected" });
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom).state).toBe("connected");
    });

    it("permits retry from expired and error states without surfacing raw server messages", async () => {
        model.mount();
        model.applyStatus({ state: "expired", message: "fictional-secret" });
        expect(renderSetup()).toContain("Retry connection");
        vi.mocked(RpcApi.CroweAuthStartCommand).mockRejectedValueOnce(new Error("fictional-secret"));
        await model.start();
        expect(renderSetup()).toContain("Retry connection");
        expect(renderSetup()).not.toContain("fictional-secret");
        await model.start();
        expect(globalStore.get(model.statusAtom).state).toBe("pending");
    });
});

describe("account surface", () => {
    it("renders no secrets, server messages, or server-controlled verification addresses", () => {
        model.applyStatus({
            ...PendingStatus,
            accesstoken: "fictional-access-secret",
            refreshtoken: "fictional-refresh-secret",
            devicecode: "fictional-device-secret",
        } as CroweAuthStatus);
        const markup = renderSetup();
        expect(markup).toContain(CroweDeviceUrl);
        expect(markup).toContain("ABCD-EFGH");
        expect(markup).not.toContain("fictional-");
        expect(markup).not.toContain("untrusted.example");
        expect(JSON.stringify(globalStore.get(model.statusAtom))).not.toContain("fictional-");
        expect(markup).toContain("Connecting does not send a prompt, read files, or run commands");
    });

    it("explains expired sessions without claiming a device code expired", () => {
        model.applyStatus({ state: "expired" });
        const markup = renderSetup();
        expect(markup).toContain("Your sign-in or account session has expired");
        expect(markup).not.toContain("This code has expired");
        expect(markup).toContain("Your chat and draft stay in place");
    });

    it("maps only exact secure storage messages to actionable local copy", () => {
        const storage = "Crowe account secure storage is unavailable";
        model.applyStatus({ state: "error", message: storage });
        expect(globalStore.get(model.statusAtom)).toEqual({ state: "error", problem: "storage" });
        expect(renderSetup()).toContain("Unlock your system keychain or credential service");
        expect(renderSetup()).not.toContain("Check your network");
        for (const message of [`${storage}: fictional-secret`, `prefix ${storage}`, "fictional-secret"]) {
            model.applyStatus({ state: "error", message });
            expect(globalStore.get(model.statusAtom)).toEqual({ state: "error" });
            expect(renderSetup()).not.toContain("fictional-secret");
            expect(renderSetup()).not.toContain("Unlock your system keychain");
        }
    });

    it("shows a signed-out cleanup warning and allows deliberate removal retry", async () => {
        const message =
            "Disconnected locally; secure credential cleanup failed. Disconnection may not survive an app restart.";
        model.mount();
        model.applyStatus({ state: "signedout", message });
        expect(globalStore.get(model.statusAtom)).toEqual({ state: "signedout", problem: "cleanup" });
        const markup = renderSetup();
        expect(markup).toContain("saved credentials could not be removed");
        expect(markup).toContain("before restarting Hypheus");
        expect(markup).toContain("Retry credential removal");
        await model.disconnect();
        expect(RpcApi.CroweAuthDisconnectCommand).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.statusAtom)).toEqual({ state: "signedout" });
        model.applyStatus({ state: "signedout", message: `${message} fictional-secret` });
        expect(globalStore.get(model.statusAtom)).toEqual({ state: "signedout" });
        expect(renderSetup()).not.toContain("fictional-secret");
        expect(renderSetup()).not.toContain("Retry credential removal");
    });

    it("keeps cleanup guidance when status polling reports an expired rejected session", async () => {
        const message =
            "Crowe session expired; secure credential cleanup failed. Disconnection may not survive an app restart.";
        model.applyStatus({
            state: "signedout",
            message:
                "Disconnected locally; secure credential cleanup failed. Disconnection may not survive an app restart.",
        });
        vi.mocked(RpcApi.CroweAuthStatusCommand).mockResolvedValue({ state: "expired", message });
        model.mount();
        await vi.advanceTimersByTimeAsync(0);
        expect(globalStore.get(model.statusAtom)).toEqual({ state: "expired", problem: "cleanup" });
        expect(renderSetup()).toContain("saved credentials could not be removed");
        expect(renderSetup()).toContain("Retry credential removal");
        model.applyStatus({ state: "expired", message: `${message} fictional-secret` });
        expect(globalStore.get(model.statusAtom)).toEqual({ state: "expired" });
        expect(renderSetup()).not.toContain("fictional-secret");
    });

    it("clears codes on all terminal states and rejects malformed codes", () => {
        for (const state of ["signedout", "connected", "expired", "error"]) {
            expect(sanitizeCroweAccountStatus({ ...PendingStatus, state })).toEqual({ state });
        }
        for (const usercode of ["<script>", "A\nB", "A".repeat(33), "", "ABC?token=secret"]) {
            expect(sanitizeCroweAccountStatus({ ...PendingStatus, usercode })).toEqual({ state: "error" });
        }
        expect(sanitizeCroweAccountStatus({ state: "unknown" })).toEqual({ state: "error" });
    });

    it("shows setup for account mode only unless explicitly opened", () => {
        expect(isCroweAccountMode(CroweAccountMode)).toBe(true);
        expect(isCroweAccountMode("custom", { "display:name": "Account", "ai:apitype": "crowe-gateway" })).toBe(true);
        for (const mode of ["local", "waveai@crowelm-auto", "custom"]) {
            expect(isCroweAccountMode(mode, { "display:name": "Custom", "ai:apitype": "openai-chat" })).toBe(false);
        }
        expect(renderSetup(false)).toBe("");
        expect(renderSetup()).toContain("Connect account");
        model.showSetup();
        expect(renderSetup(false)).toContain("Use account mode");
        expect(renderSetup(false)).toContain("Your selected engine has not changed");
        model.applyStatus({ state: "connected" });
        expect(renderSetup()).toContain("Disconnect account");
        model.hideSetup();
        expect(renderSetup()).toBe("");
    });

    it.each([
        ["signedout", "Not connected"],
        ["connected", "Connected"],
        ["expired", "Connection expired"],
        ["error", "Connection unavailable"],
    ])("names the %s account state in the header accessibly", (state, label) => {
        model.applyStatus({ state });
        const markup = renderToStaticMarkup(
            <Provider store={globalStore}>
                <CroweAccountButton onClick={() => {}} />
            </Provider>
        );
        expect(markup).toContain(`Crowe account: ${label}. Open account setup`);
        expect(markup).toContain(`<span>${label}</span>`);
        expect(markup).toContain("focus-visible:outline");
    });
});
