// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";

export const CroweAccountMode = "waveai@crowe-account";
export const CroweDeviceUrl = "https://id.crowelogic.com/realms/crowe/device";
export const CroweSignInRequired = "Connect your Crowe account in Hypheus to continue.";
const PollIntervalMs = 2500;
const RpcTimeoutMs = 15000;

export type CroweAccountState = "signedout" | "starting" | "pending" | "connected" | "expired" | "error";
export type CroweAccountStatus = {
    state: CroweAccountState;
    usercode?: string;
    expiresat?: number;
    problem?: "storage" | "cleanup";
};
type AccountOperation = "start" | "cancel" | "disconnect";

export function isCroweAccountMode(mode: string, config?: AIModeConfigType): boolean {
    return mode === CroweAccountMode || config?.["ai:apitype"] === "crowe-gateway";
}

export function isCroweSignInRequired(message: string): boolean {
    return message?.includes(CroweSignInRequired) || message?.includes("ErrSignInRequired");
}

export function isCroweLegacyKeyError(message: string): boolean {
    return (
        message?.includes("Crowe Logic model authentication is not configured") ||
        /secret CROWE_MODELS_KEY (?:not found or empty|is not configured)/.test(message ?? "")
    );
}

export function sanitizeCroweAccountStatus(status: CroweAuthStatus): CroweAccountStatus {
    switch (status?.state) {
        case "error":
            return status.message === "Crowe account secure storage is unavailable"
                ? { state: "error", problem: "storage" }
                : { state: "error" };
        case "signedout":
            return status.message ===
                "Disconnected locally; secure credential cleanup failed. Disconnection may not survive an app restart."
                ? { state: "signedout", problem: "cleanup" }
                : { state: "signedout" };
        case "expired":
            return status.message ===
                "Crowe session expired; secure credential cleanup failed. Disconnection may not survive an app restart."
                ? { state: "expired", problem: "cleanup" }
                : { state: "expired" };
        case "starting":
        case "connected":
            return { state: status.state };
        case "pending": {
            if (typeof status.usercode !== "string" || !/^[A-Z0-9-]{1,32}$/.test(status.usercode)) {
                return { state: "error" };
            }
            const expiresat =
                Number.isSafeInteger(status.expiresat) && status.expiresat > 0 && status.expiresat <= 8640000000000000
                    ? status.expiresat
                    : null;
            return { state: "pending", usercode: status.usercode, ...(expiresat ? { expiresat } : {}) };
        }
        default:
            return { state: "error" };
    }
}

export class CroweAccountModel {
    private static instance: CroweAccountModel = null;
    statusAtom: jotai.PrimitiveAtom<CroweAccountStatus> = jotai.atom({ state: "signedout" });
    checkedAtom = jotai.atom(false);
    setupVisibleAtom = jotai.atom(false);
    operationAtom: jotai.PrimitiveAtom<AccountOperation> = jotai.atom(null) as jotai.PrimitiveAtom<AccountOperation>;
    browserErrorAtom = jotai.atom(false);
    mountCount = 0;
    revision = 0;
    pollInFlight = false;
    pollTimer: ReturnType<typeof setTimeout> = null;
    pendingOperations = 0;
    operationTail: Promise<void> = Promise.resolve();

    private constructor() {}

    static getInstance(): CroweAccountModel {
        if (!CroweAccountModel.instance) {
            CroweAccountModel.instance = new CroweAccountModel();
        }
        return CroweAccountModel.instance;
    }

    static resetInstance() {
        if (CroweAccountModel.instance) {
            CroweAccountModel.instance.mountCount = 0;
            CroweAccountModel.instance.revision++;
            CroweAccountModel.instance.clearPollTimer();
        }
        CroweAccountModel.instance = null;
    }

    mount(): () => void {
        this.mountCount++;
        this.schedulePoll(0);
        let mounted = true;
        return () => {
            if (!mounted) return;
            mounted = false;
            this.mountCount--;
            if (this.mountCount === 0) {
                this.revision++;
                this.clearPollTimer();
            }
        };
    }

    showSetup() {
        globalStore.set(this.setupVisibleAtom, true);
    }

    hideSetup() {
        globalStore.set(this.setupVisibleAtom, false);
    }

    clearPollTimer() {
        if (this.pollTimer != null) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    schedulePoll(delay = PollIntervalMs) {
        if (this.mountCount === 0 || this.pollInFlight || this.pendingOperations > 0 || this.pollTimer != null) {
            return;
        }
        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            void this.poll();
        }, delay);
    }

    async poll() {
        if (this.mountCount === 0 || this.pollInFlight || this.pendingOperations > 0) return;
        this.pollInFlight = true;
        const revision = this.revision;
        try {
            const status = await RpcApi.CroweAuthStatusCommand(TabRpcClient, { timeout: RpcTimeoutMs });
            if (revision === this.revision && this.mountCount > 0) {
                this.applyStatus(status);
            }
        } catch {
            if (revision === this.revision && this.mountCount > 0) {
                this.applyStatus({ state: "error" });
            }
        } finally {
            this.pollInFlight = false;
            // A stale request still owns the polling slot across unmounts and account operations.
            this.schedulePoll();
        }
    }

    applyStatus(status: CroweAuthStatus) {
        globalStore.set(this.statusAtom, sanitizeCroweAccountStatus(status));
        globalStore.set(this.checkedAtom, true);
    }

    openBrowser() {
        globalStore.set(this.browserErrorAtom, false);
        try {
            getApi().openExternal(CroweDeviceUrl);
        } catch {
            globalStore.set(this.browserErrorAtom, true);
        }
    }

    start(): Promise<void> {
        if (this.pendingOperations > 0 || globalStore.get(this.statusAtom).state === "connected") {
            return Promise.resolve();
        }
        this.showSetup();
        return this.runOperation("start");
    }

    cancel(): Promise<void> {
        if (globalStore.get(this.operationAtom) === "cancel" || globalStore.get(this.operationAtom) === "disconnect") {
            return Promise.resolve();
        }
        return this.runOperation("cancel");
    }

    disconnect(): Promise<void> {
        if (this.pendingOperations > 0) return Promise.resolve();
        return this.runOperation("disconnect");
    }

    runOperation(operation: AccountOperation): Promise<void> {
        const revision = ++this.revision;
        this.pendingOperations++;
        this.clearPollTimer();
        globalStore.set(this.operationAtom, operation);
        globalStore.set(this.browserErrorAtom, false);
        if (operation === "start") {
            globalStore.set(this.statusAtom, { state: "starting" });
        } else if (operation === "cancel") {
            globalStore.set(this.statusAtom, { state: "signedout" });
        }
        const task = this.operationTail.then(async () => {
            try {
                const command = {
                    start: RpcApi.CroweAuthStartCommand,
                    cancel: RpcApi.CroweAuthCancelCommand,
                    disconnect: RpcApi.CroweAuthDisconnectCommand,
                }[operation];
                const status = await command.call(RpcApi, TabRpcClient, { timeout: RpcTimeoutMs });
                if (revision !== this.revision || this.mountCount === 0) return;
                this.applyStatus(status);
                if (operation === "start" && globalStore.get(this.statusAtom).state === "pending") {
                    this.openBrowser();
                }
            } catch {
                if (revision === this.revision && this.mountCount > 0) {
                    this.applyStatus({ state: "error" });
                }
            } finally {
                this.pendingOperations--;
                if (this.pendingOperations === 0) {
                    globalStore.set(this.operationAtom, null);
                    this.schedulePoll(0);
                }
            }
        });
        this.operationTail = task.catch(() => {});
        return task;
    }
}
