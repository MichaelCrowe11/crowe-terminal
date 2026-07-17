// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { createBlock } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { WaveAIModel } from "./waveai-model";

type CroweChannel = {
    id: string;
    name: string;
    scope: string;
    prompt: string;
    // Optional block to spawn in the focused tab on click. When set, clicking
    // the lane both inserts the prompt AND opens the matching workspace block
    // — the "click and a destination opens" promise the lanes look like they
    // make. Without a blockdef the lane is channel-only (prompt template).
    blockdef?: BlockDef;
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
        blockdef: { meta: { view: "crowecode" } },
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

export const CroweChannelPanel = memo(() => {
    const model = WaveAIModel.getInstance();
    const widgetAccess = useAtomValue(model.widgetAccessAtom);

    const insertChannelPrompt = (channel: CroweChannel) => {
        model.appendText(channel.prompt);
        model.focusInput();
        if (channel.blockdef != null) {
            fireAndForget(() => createBlock(channel.blockdef!));
        }
    };

    return (
        <section className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em]">
                <span className="text-[var(--crowe-parchment-45)]">Start a lane</span>
                <span className="flex items-center gap-1.5 text-[var(--crowe-parchment-40)]">
                    <span
                        className={cn(
                            "h-1 w-1 rounded-full",
                            widgetAccess ? "bg-[var(--accent)]" : "bg-[var(--text-dim)]"
                        )}
                    />
                    {widgetAccess ? "tools live" : "text only"}
                </span>
            </div>

            <div className="grid grid-cols-1 gap-1.5">
                {CHANNELS.map((channel) => (
                    <button
                        key={channel.id}
                        type="button"
                        onClick={() => insertChannelPrompt(channel)}
                        className="group flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--hairline-faint)] bg-[var(--surface-sunken)] px-3 py-2.5 text-left transition-all duration-200 [box-shadow:inset_0_1px_0_var(--hair-top)] hover:-translate-y-px hover:border-[var(--crowe-gold-40)] hover:bg-[var(--wash-accent-faint)] hover:shadow-[var(--glass-fruiting-glow)] cursor-pointer"
                    >
                        <div className="min-w-0">
                            <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--accent)]">
                                {channel.name}
                            </div>
                            <div className="mt-1 truncate text-[12px] leading-relaxed text-[var(--text-dim)]">
                                {channel.scope}
                            </div>
                        </div>
                        <i className="fa fa-arrow-right flex-shrink-0 text-[11px] text-[var(--crowe-parchment-32)] transition-all group-hover:translate-x-0.5 group-hover:text-[var(--crowe-gold-65)]" />
                    </button>
                ))}
            </div>
        </section>
    );
});

CroweChannelPanel.displayName = "CroweChannelPanel";
