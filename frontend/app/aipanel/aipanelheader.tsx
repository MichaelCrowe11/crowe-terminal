// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { handleWaveAIContextMenu } from "@/app/aipanel/aipanel-contextmenu";
import { cn } from "@/util/util";
import { CroweCodeWorkspaceModel } from "@/app/view/crowecode/crowecode-workspace-model";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import { WaveAIModel } from "./waveai-model";
import croweMark from "@/app/asset/crowe-mark.png";
import croweWordmarkUrl from "@/app/asset/crowe-wordmark.svg?url";

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
            className="py-2 pl-3 pr-2 flex items-center justify-between min-w-0 border-b border-[var(--hairline)] bg-[var(--glass-tint-chrome)] backdrop-blur-2xl"
            onContextMenu={handleContextMenu}
        >
            <div className="min-w-0 flex items-center gap-2.5">
                <button
                    type="button"
                    onClick={openCroweCode}
                    className="group min-w-0 flex items-center gap-2.5 cursor-pointer"
                    title="Open crowelogic.com"
                >
                    <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--hairline-strong)] bg-[var(--surface-sunken)]">
                        <img src={croweMark} alt="" className="h-full w-full object-cover" />
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                            <img src={croweWordmarkUrl} alt="Crowe Logic" className="h-4 w-auto flex-shrink-0" />
                            <span
                                className={cn(
                                    "h-1.5 w-1.5 rounded-full bg-[var(--crowe-gold-45)]",
                                    isStreaming && "animate-pulse bg-[var(--accent)] shadow-[0_0_8px_var(--glow-gold)]"
                                )}
                            />
                        </div>
                        <div
                            className={cn(
                                "truncate text-[11px] mt-0.5 group-hover:text-[var(--accent)]",
                                activeLabel ? "font-mono text-[var(--crowe-gold-65)]" : "text-[var(--text-dim)]"
                            )}
                            title={activeEditor?.filePath ?? "Managed workspace"}
                        >
                            {activeLabel ?? "Managed workspace"}
                        </div>
                    </div>
                </button>
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
                {!inBuilder && (
                    <button
                        type="button"
                        onClick={() => model.openCroweAccount()}
                        className="rounded-[var(--radius-sm)] border border-[var(--crowe-gold-30)] bg-[var(--wash-accent-faint)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--crowe-gold-65)] transition-colors hover:border-[var(--crowe-gold-60)] hover:bg-[var(--wash-accent)] cursor-pointer"
                        title="Sign in to your Crowe Logic account"
                    >
                        Sign in
                    </button>
                )}
                {!inBuilder && (
                    <button
                        onClick={toggleContext}
                        title={
                            widgetAccess
                                ? "Tools are ON. The agent can read your terminal, files, and use editor.* tools. Click to sandbox."
                                : "Tools are OFF (sandboxed). The agent is text-only and cannot reach files or the terminal. Click to enable."
                        }
                        className={`group flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] px-2 py-1 border rounded-[var(--radius-sm)] transition-colors cursor-pointer ${
                            widgetAccess
                                ? "text-[var(--accent)] border-[var(--crowe-gold-40)] bg-[var(--wash-accent)] hover:bg-[var(--wash-accent-mid)]"
                                : "text-[var(--text-dim)] border-[var(--hairline)] bg-transparent hover:border-[var(--hairline-strong)] hover:text-[var(--text)]"
                        }`}
                    >
                        <span
                            className={`inline-block h-1.5 w-1.5 rounded-full ${
                                widgetAccess ? "bg-[var(--accent)]" : "bg-[var(--text-dim)]"
                            }`}
                        />
                        <span>tools: {widgetAccess ? "on" : "off"}</span>
                    </button>
                )}

                <button
                    onClick={handleKebabClick}
                    className="text-[var(--text-dim)] hover:text-[var(--accent)] cursor-pointer transition-colors p-1 flex-shrink-0 focus:outline-none"
                    title="More options"
                >
                    <i className="fa fa-ellipsis-vertical"></i>
                </button>
            </div>
        </div>
    );
});

AIPanelHeader.displayName = "AIPanelHeader";
