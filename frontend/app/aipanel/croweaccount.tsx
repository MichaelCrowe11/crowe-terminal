// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { CroweAccountModel, CroweAccountState, CroweDeviceUrl } from "./croweaccount-model";
import type { WaveAIModel } from "./waveai-model";

const ButtonClass =
    "rounded border border-[var(--hairline-strong)] px-3 py-1.5 text-[12px] text-[var(--text)] hover:bg-[var(--surface-raised-hover)] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
const StateLabels: Record<CroweAccountState, string> = {
    signedout: "Not connected",
    starting: "Connecting",
    pending: "Waiting for approval",
    connected: "Connected",
    expired: "Connection expired",
    error: "Connection unavailable",
};

export function CroweAccountButton({ onClick }: { onClick: () => void }) {
    const model = CroweAccountModel.getInstance();
    const status = useAtomValue(model.statusAtom);
    const checked = useAtomValue(model.checkedAtom);
    const label = checked || status.state === "starting" ? StateLabels[status.state] : "Checking connection";

    return (
        <button
            type="button"
            onClick={onClick}
            title={`Crowe account: ${label}`}
            aria-label={`Crowe account: ${label}. Open account setup`}
            className="flex items-center gap-1.5 rounded border border-[var(--hairline)] px-2 py-1 text-[12px] text-[var(--text)] hover:bg-[var(--surface-raised-hover)] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
            <i className="fa fa-regular fa-circle-user text-[12px]" aria-hidden="true" />
            <span>{label}</span>
        </button>
    );
}

export function CroweAccountDraftRecovery({ model }: { model: WaveAIModel }) {
    const drafts = useAtomValue(model.unsentAccountDrafts);
    const input = useAtomValue(model.inputAtom);
    const files = useAtomValue(model.droppedFiles);
    const chatid = useAtomValue(model.chatId);
    const draft = drafts[0];
    const occupied = !!input || files.length > 0;

    if (!draft) return null;

    return (
        <section
            aria-label="Unsent account request"
            className="mx-2 mb-2 rounded border border-[var(--hairline)] bg-[var(--surface-raised)] p-3 text-[12px] text-[var(--text)]"
        >
            <p>
                Your request was not sent because sign-in is required. The prompt and attachments are kept here until
                restored or discarded.
            </p>
            <p className="mt-1 text-[var(--text-dim)]">
                {occupied
                    ? "Save or clear your current draft before restoring this request."
                    : "Restore the draft, connect your account, then send when ready."}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={occupied}
                    onClick={() => model.restoreAccountDraft(draft.messageid)}
                    className={ButtonClass}
                >
                    {chatid === draft.chatid ? "Restore unsent draft" : "Restore into this chat"}
                </button>
                <button
                    type="button"
                    onClick={() => model.discardAccountDraft(draft.messageid)}
                    className={ButtonClass}
                >
                    Discard unsent request
                </button>
            </div>
        </section>
    );
}

export function CroweAccountSetup({ accountMode, onUseAccount }: { accountMode: boolean; onUseAccount?: () => void }) {
    const model = CroweAccountModel.getInstance();
    const status = useAtomValue(model.statusAtom);
    const checked = useAtomValue(model.checkedAtom);
    const requested = useAtomValue(model.setupVisibleAtom);
    const operation = useAtomValue(model.operationAtom);
    const browserError = useAtomValue(model.browserErrorAtom);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const visible = requested || (accountMode && status.state !== "connected");
    const waiting = status.state === "pending";
    const starting = status.state === "starting";
    const connected = status.state === "connected";
    const canCancel = waiting || starting;
    const retry = status.state === "expired" || status.state === "error";

    useEffect(() => {
        if (requested) headingRef.current?.focus();
    }, [requested]);

    if (!visible) return null;

    return (
        <section
            aria-label="Crowe account setup"
            className="mx-2 my-2 max-h-[50%] shrink-0 overflow-y-auto rounded border border-[var(--hairline)] border-t-[var(--hairline-strong)] bg-[var(--surface-raised)] p-3 text-[13px] text-[var(--text)]"
        >
            <div className="flex items-start justify-between gap-3">
                <h2
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                    Crowe account
                </h2>
                {requested && (!accountMode || connected) && (
                    <button type="button" onClick={() => model.hideSetup()} className={cn(ButtonClass, "px-2 py-0.5")}>
                        Close
                    </button>
                )}
            </div>
            <p role="status" aria-live="polite" className="mt-1 text-[12px] text-[var(--text-dim)]">
                {operation === "cancel"
                    ? "Canceling connection"
                    : operation === "disconnect"
                      ? "Disconnecting"
                      : !checked && !starting
                        ? "Checking account connection"
                        : StateLabels[status.state]}
            </p>
            {!connected && !waiting && (
                <p className="mt-2 leading-relaxed">
                    {status.problem === "storage"
                        ? "Hypheus could not access secure credential storage. Unlock your system keychain or credential service, allow Hypheus access, then retry."
                        : status.problem === "cleanup"
                          ? "Disconnected in this session, but saved credentials could not be removed. Restore access to your system credential service, then retry removal before restarting Hypheus."
                          : status.state === "expired"
                            ? "Your sign-in or account session has expired. Connect again to continue. Your chat and draft stay in place."
                            : status.state === "error"
                              ? "Could not confirm your connection. Check your network and try again."
                              : "Connect your Crowe account to use cloud models in Hypheus. No API key is needed for account mode."}
                </p>
            )}
            {waiting && (
                <div className="mt-2 space-y-2">
                    <p>In your browser, sign in to Crowe ID and enter this code. Return here after approval.</p>
                    <div
                        className="select-text rounded border border-[var(--hairline-strong)] bg-[var(--surface)] px-3 py-2 font-mono text-[13px] tracking-widest"
                        aria-label="One-time sign-in code"
                    >
                        {status.usercode}
                    </div>
                    <p className="break-all text-[12px] text-[var(--text-dim)]">{CroweDeviceUrl}</p>
                    {status.expiresat && (
                        <p className="text-[12px] text-[var(--text-dim)]">
                            Code expires at{" "}
                            {new Date(status.expiresat).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
                        </p>
                    )}
                </div>
            )}
            {connected && <p className="mt-2">Your account is connected. Your current chat and draft stay in place.</p>}
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-dim)]">
                Connecting does not send a prompt, read files, or run commands. Tool access and approvals stay separate.
            </p>
            {browserError && (
                <p role="alert" className="mt-2 text-[12px] text-[var(--crowe-error)]">
                    Could not open the browser. Open the address above in your system browser and enter the code.
                </p>
            )}
            {!accountMode && (
                <p className="mt-2 text-[12px] text-[var(--text-dim)]">
                    Your selected engine has not changed. Choose account mode to send requests through your Crowe
                    account.
                </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
                {!accountMode && onUseAccount && (
                    <button type="button" onClick={onUseAccount} className={ButtonClass}>
                        Use account mode
                    </button>
                )}
                {!connected && !canCancel && (
                    <button
                        type="button"
                        disabled={operation != null}
                        onClick={() => void model.start()}
                        className={cn(ButtonClass, "bg-accent/80 text-primary hover:bg-accent transition-colors")}
                    >
                        {retry ? "Retry connection" : "Connect account"}
                    </button>
                )}
                {waiting && (
                    <button type="button" onClick={() => model.openBrowser()} className={ButtonClass}>
                        Open sign-in page
                    </button>
                )}
                {canCancel && (
                    <button
                        type="button"
                        disabled={operation === "cancel"}
                        onClick={() => void model.cancel()}
                        className={ButtonClass}
                    >
                        Cancel
                    </button>
                )}
                {(connected || status.problem === "cleanup") && (
                    <button
                        type="button"
                        disabled={operation != null}
                        onClick={() => void model.disconnect()}
                        className={ButtonClass}
                    >
                        {status.problem === "cleanup" ? "Retry credential removal" : "Disconnect account"}
                    </button>
                )}
            </div>
            {!connected && (
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-dim)]">
                    Local and custom engines still work without connecting. API-key modes remain available in the engine
                    menu as advanced setup.
                </p>
            )}
        </section>
    );
}
