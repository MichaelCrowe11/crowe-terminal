// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { handleWaveAIContextMenu } from "@/app/aipanel/aipanel-contextmenu";
import { cn } from "@/util/util";
import { CroweCodeWorkspaceModel } from "@/app/view/crowecode/crowecode-workspace-model";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import { WaveAIModel } from "./waveai-model";
import croweFace from "@/app/asset/crowe-face.png";

export const AIPanelHeader = memo(() => {
    const model = WaveAIModel.getInstance();
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

    return (
        <div
            className="py-2 pl-3 pr-2 flex items-center justify-between min-w-0 border-b border-[#bfa669]/18 bg-[#0b0b0c]/90"
            onContextMenu={handleContextMenu}
        >
            <div className="flex items-center gap-2.5 min-w-0">
                <div className="relative h-8 w-8 flex-shrink-0 rounded-full bg-[#0b0b0c] overflow-hidden">
                    <span
                        className={cn(
                            "absolute inset-[-3px] rounded-full border border-[#bfa669]/25",
                            isStreaming && "animate-spin border-t-[#bfa669] border-r-[#bfa669]/60"
                        )}
                    />
                    <img
                        src={croweFace}
                        alt=""
                        className="relative h-full w-full rounded-full object-cover"
                    />
                </div>
                <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#bfa669]/75 whitespace-nowrap">
                        CroweLM
                    </div>
                    <div
                        className={cn(
                            "truncate text-[11px]",
                            activeLabel ? "font-mono text-[#bfa669]/85" : "text-[#e8e2cf]/48"
                        )}
                        title={activeEditor?.filePath ?? "Managed workspace"}
                    >
                        {activeLabel ?? "Managed workspace"}
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
                {!inBuilder && (
                    <button
                        type="button"
                        onClick={() => model.openCroweAccount()}
                        className="border border-[#bfa669]/28 bg-[#bfa669]/[0.04] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#bfa669]/85 transition-colors hover:border-[#bfa669]/60 hover:bg-[#bfa669]/[0.10]"
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
                                ? "Tools are ON. The AI can read your terminal, files, and use editor.* tools. Click to sandbox."
                                : "Tools are OFF (sandboxed). The AI is text-only and cannot reach files or the terminal. Click to enable."
                        }
                        className={`group flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] px-2 py-1 border transition-colors cursor-pointer ${
                            widgetAccess
                                ? "text-[#bfa669] border-[#bfa669]/40 bg-[#bfa669]/[0.08] hover:bg-[#bfa669]/[0.14]"
                                : "text-zinc-400 border-zinc-700 bg-transparent hover:border-zinc-500 hover:text-zinc-300"
                        }`}
                    >
                        <span
                            className={`inline-block h-1.5 w-1.5 rounded-[1px] ${
                                widgetAccess ? "bg-[#bfa669]" : "bg-zinc-500"
                            }`}
                        />
                        <span>tools: {widgetAccess ? "on" : "off"}</span>
                    </button>
                )}

                <button
                    onClick={handleKebabClick}
                    className="text-zinc-400 hover:text-[#bfa669] cursor-pointer transition-colors p-1 flex-shrink-0 focus:outline-none"
                    title="More options"
                >
                    <i className="fa fa-ellipsis-vertical"></i>
                </button>
            </div>
        </div>
    );
});

AIPanelHeader.displayName = "AIPanelHeader";
