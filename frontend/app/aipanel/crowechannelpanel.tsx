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

export const CroweChannelPanel = memo(({ compact = false }: { compact?: boolean }) => {
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
        <section className={cn("glass-raised rounded-[var(--radius-md)]", compact ? "p-3" : "p-4")}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--crowe-gold-30)] bg-[var(--wash-accent-faint)] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--accent)]">
                        <span className="h-1 w-1 rounded-full animate-pulse bg-[var(--accent)]" />
                        Signed workspace
                    </div>
                    <div
                        className="mt-2 text-[16px] font-semibold text-[var(--text)]"
                        style={{ fontFamily: "var(--font-serif)" }}
                    >
                        CroweLM channels
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-dim)]">
                        Pick the work lane. Crowe Logic handles routing, context, and tool access behind the workspace.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => model.openCroweAccount()}
                    className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--crowe-gold-35)] bg-[var(--wash-accent)] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)] transition-colors hover:border-[var(--crowe-gold-60)] hover:bg-[var(--wash-accent-mid)] cursor-pointer"
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
                        className="group min-h-[72px] rounded-[var(--radius-md)] border border-[var(--hairline-faint)] bg-[var(--wash-accent-faint)] p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--crowe-gold-40)] hover:bg-[var(--wash-accent)] hover:shadow-[var(--glass-fruiting-glow)] cursor-pointer"
                    >
                        <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-[10px] uppercase tracking-[0.20em] text-[var(--accent)]">
                                {channel.name}
                            </span>
                            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-transparent transition-colors group-hover:text-[var(--crowe-gold-65)]">
                                use →
                            </span>
                        </div>
                        <div className="mt-2 text-[12px] leading-relaxed text-[var(--text-dim)]">{channel.scope}</div>
                    </button>
                ))}
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-[var(--hairline-faint)] pt-3 font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--crowe-parchment-40)]">
                <span>{widgetAccess ? "tools live" : "text only"}</span>
                <span>no keys · no provider setup</span>
            </div>
        </section>
    );
});

CroweChannelPanel.displayName = "CroweChannelPanel";
