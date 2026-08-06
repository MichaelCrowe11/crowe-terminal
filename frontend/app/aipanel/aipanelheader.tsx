// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { handleWaveAIContextMenu } from "@/app/aipanel/aipanel-contextmenu";
import { cn } from "@/util/util";
import { CroweCodeWorkspaceModel } from "@/app/view/crowecode/crowecode-workspace-model";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import { WaveAIModel } from "./waveai-model";
import croweMark from "@/app/asset/hypheus-mark.png";
import croweWordmarkUrl from "@/app/asset/hypheus-wordmark.svg?url";

export const AIPanelHeader = memo(() => {
    const model = WaveAIModel.getInstance();
    const waveEnv = useWaveEnv();
    const widgetAccess = useAtomValue(model.widgetAccessAtom);
    const isStreaming = useAtomValue(model.isAIStreaming);
    const inBuilder = model.inBuilder;
    const activeEditor = useAtomValue(CroweCodeWorkspaceModel.getInstance().activeEditorAtom);
    const activeLabel = useMemo(() => {
        if (!activeEditor) return null;
        const base = activeEditor.filePath.split("/").pop() || activeEditor.filePath;
        return `${base} · L${activeEditor.cursorLine}`;
    }, [activeEditor]);

    const handleKebabClick = (e: React.MouseEvent) => {
        handleWaveAIContextMenu(e, false);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        handleWaveAIContextMenu(e, false);
    };

    const toggleContext = () => {
        model.setWidgetAccess(!widgetAccess);
        setTimeout(() => model.focusInput(), 0);
    };

    const openCroweCode = () => {
        // Temporary fallback while crowecode.com DNS/TLS is being finalized.
        waveEnv.electron.openExternal("https://www.crowelogic.com");
    };

    return (
        <div
            className="flex h-11 min-w-0 items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--glass-tint-chrome)] pl-3 pr-1.5 backdrop-blur-2xl [box-shadow:inset_0_1px_0_var(--hair-top)]"
            onContextMenu={handleContextMenu}
        >
            <button
                type="button"
                onClick={openCroweCode}
                className="group flex min-w-0 items-center gap-2 cursor-pointer"
                title="Open crowelogic.com"
            >
                <div className="relative h-6 w-6 flex-shrink-0 overflow-hidden rounded-[var(--radius-xs)] border border-[var(--hairline-strong)] bg-[var(--surface-sunken)]">
                    <img src={croweMark} alt="" className="h-full w-full object-cover" />
                </div>
                <img src={croweWordmarkUrl} alt="Hypheus" className="h-[13px] w-auto flex-shrink-0 opacity-90" />
                <span
                    className={cn(
                        "h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--crowe-gold-45)] transition-all",
                        isStreaming && "animate-pulse bg-[var(--accent)] shadow-[0_0_8px_var(--glow-gold)]"
                    )}
                />
                {activeLabel && (
                    <span
                        className="ml-1 min-w-0 truncate font-mono text-[10px] text-[var(--crowe-gold-65)] group-hover:text-[var(--accent)]"
                        title={activeEditor?.filePath ?? undefined}
                    >
                        {activeLabel}
                    </span>
                )}
            </button>

            <div className="flex flex-shrink-0 items-center gap-0.5 whitespace-nowrap">
                {!inBuilder && (
                    <button
                        type="button"
                        onClick={toggleContext}
                        title={
                            widgetAccess
                                ? "Tools are on. The operator can read your terminal, files, and use editor tools. Click to sandbox."
                                : "Tools are off (sandboxed). The operator is text-only and cannot reach files or the terminal. Click to enable."
                        }
                        aria-pressed={widgetAccess}
                        className={cn(
                            "flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors cursor-pointer",
                            widgetAccess
                                ? "border-[var(--crowe-gold-40)] bg-[var(--wash-accent)] text-[var(--accent)] hover:bg-[var(--wash-accent-mid)]"
                                : "border-[var(--hairline)] bg-transparent text-[var(--text-dim)] hover:border-[var(--hairline-strong)] hover:text-[var(--text)]"
                        )}
                    >
                        <span
                            className={cn(
                                "inline-block h-1.5 w-1.5 rounded-full",
                                widgetAccess ? "bg-[var(--accent)] shadow-[0_0_6px_var(--glow-gold)]" : "bg-[var(--text-dim)]"
                            )}
                        />
                        tools
                    </button>
                )}
                {!inBuilder && (
                    <button
                        type="button"
                        onClick={() => model.openCroweAccount()}
                        title="Sign in to your Crowe Logic account"
                        aria-label="Sign in"
                        className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-dim)] transition-colors hover:bg-[var(--wash-accent-faint)] hover:text-[var(--accent)] cursor-pointer"
                    >
                        <i className="fa fa-regular fa-circle-user text-[13px]"></i>
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleKebabClick}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-dim)] transition-colors hover:bg-[var(--wash-accent-faint)] hover:text-[var(--accent)] cursor-pointer focus:outline-none"
                    title="More options"
                    aria-label="More options"
                >
                    <i className="fa fa-ellipsis-vertical text-[13px]"></i>
                </button>
            </div>
        </div>
    );
});

AIPanelHeader.displayName = "AIPanelHeader";
