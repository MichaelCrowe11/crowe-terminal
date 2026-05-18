// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { WaveAIModel } from "./waveai-model";

type CroweChannel = {
    id: string;
    name: string;
    scope: string;
    prompt: string;
};

const CHANNELS: CroweChannel[] = [
    {
        id: "workspace",
        name: "Workspace",
        scope: "Terminal, files, browser, diffs",
        prompt: "Inspect this workspace and tell me what matters right now.",
    },
    {
        id: "code",
        name: "Code",
        scope: "Implement, refactor, test, review",
        prompt: "Review the current project, identify the next useful code change, and make a concrete plan.",
    },
    {
        id: "research",
        name: "Research",
        scope: "Docs, source analysis, citations",
        prompt: "Research this project context and summarize the decision points with source references.",
    },
    {
        id: "growops",
        name: "Grow Ops",
        scope: "Cultivation, SOPs, production data",
        prompt: "Switch into cultivation operations mode and help me reason from data, SOPs, and current constraints.",
    },
];

export const CroweChannelPanel = memo(({ compact = false }: { compact?: boolean }) => {
    const model = WaveAIModel.getInstance();
    const widgetAccess = useAtomValue(model.widgetAccessAtom);

    const insertChannelPrompt = (channel: CroweChannel) => {
        model.appendText(channel.prompt);
        model.focusInput();
    };

    return (
        <section
            className={cn(
                "border border-[#bfa669]/20 bg-[#0b0b0c]/80",
                "shadow-[inset_0_1px_0_rgba(191,166,105,0.08)]",
                compact ? "p-3" : "p-4"
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="inline-flex items-center gap-2 border border-[#bfa669]/30 bg-[#bfa669]/[0.04] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.22em] text-[#bfa669]">
                        <span className="h-1 w-1 animate-pulse bg-[#bfa669]" />
                        Signed workspace
                    </div>
                    <div className="mt-2 text-[15px] font-semibold text-[#e8e2cf]">CroweLM channels</div>
                    <p className="mt-1 text-[12px] leading-relaxed text-[#e8e2cf]/55">
                        Pick the work lane. Crowe Logic handles routing, context, and tool access behind the workspace.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => model.openCroweAccount()}
                    className="shrink-0 border border-[#bfa669]/35 bg-[#bfa669]/[0.06] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#bfa669] transition-colors hover:border-[#bfa669]/70 hover:bg-[#bfa669]/[0.12]"
                >
                    Sign in
                </button>
            </div>

            <div className={cn("grid gap-2", compact ? "mt-3 grid-cols-1" : "mt-4 grid-cols-1 @lg:grid-cols-2")}>
                {CHANNELS.map((channel) => (
                    <button
                        key={channel.id}
                        type="button"
                        onClick={() => insertChannelPrompt(channel)}
                        className="group min-h-[72px] border border-[#bfa669]/14 bg-[#bfa669]/[0.025] p-3 text-left transition-colors hover:border-[#bfa669]/45 hover:bg-[#bfa669]/[0.07]"
                    >
                        <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-[10px] uppercase tracking-[0.20em] text-[#bfa669]">
                                {channel.name}
                            </span>
                            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#e8e2cf]/0 transition-colors group-hover:text-[#bfa669]/70">
                                use
                            </span>
                        </div>
                        <div className="mt-2 text-[12px] leading-relaxed text-[#e8e2cf]/55">{channel.scope}</div>
                    </button>
                ))}
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-[#bfa669]/12 pt-3 font-mono text-[9px] uppercase tracking-[0.18em] text-[#e8e2cf]/38">
                <span>{widgetAccess ? "tools live" : "text only"}</span>
                <span>no keys · no provider setup</span>
            </div>
        </section>
    );
});

CroweChannelPanel.displayName = "CroweChannelPanel";
