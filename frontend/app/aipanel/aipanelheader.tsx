// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { handleWaveAIContextMenu } from "@/app/aipanel/aipanel-contextmenu";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { WaveAIModel } from "./waveai-model";
import croweFace from "@/app/asset/crowe-face.png";

export const AIPanelHeader = memo(() => {
    const model = WaveAIModel.getInstance();
    const widgetAccess = useAtomValue(model.widgetAccessAtom);
    const inBuilder = model.inBuilder;

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
            className="py-2 pl-3 pr-2 flex items-center justify-between min-w-0 border-b border-[#bfa669]/15 bg-[#0b0b0c]/60"
            onContextMenu={handleContextMenu}
        >
            <div className="flex items-center gap-2.5 min-w-0">
                <div className="relative h-6 w-6 flex-shrink-0 rounded-full ring-1 ring-[#bfa669]/40 bg-[#0b0b0c] overflow-hidden">
                    <img src={croweFace} alt="" className="h-full w-full object-cover" />
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#bfa669]/70 whitespace-nowrap">
                    ai panel
                </span>
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
                {!inBuilder && (
                    <button
                        onClick={toggleContext}
                        title={`Widget context is ${widgetAccess ? "ON" : "OFF"} — click to toggle`}
                        className={`group flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] px-2 py-1 rounded border transition-colors cursor-pointer ${
                            widgetAccess
                                ? "text-[#bfa669] border-[#bfa669]/40 bg-[#bfa669]/[0.08] hover:bg-[#bfa669]/[0.14]"
                                : "text-zinc-400 border-zinc-700 bg-transparent hover:border-zinc-500"
                        }`}
                    >
                        <span
                            className={`inline-block h-1.5 w-1.5 rounded-full ${
                                widgetAccess ? "bg-[#bfa669]" : "bg-zinc-500"
                            }`}
                        />
                        <span>context: {widgetAccess ? "on" : "off"}</span>
                    </button>
                )}

                <button
                    onClick={handleKebabClick}
                    className="text-zinc-400 hover:text-[#bfa669] cursor-pointer transition-colors p-1 rounded flex-shrink-0 focus:outline-none"
                    title="More options"
                >
                    <i className="fa fa-ellipsis-vertical"></i>
                </button>
            </div>
        </div>
    );
});

AIPanelHeader.displayName = "AIPanelHeader";
