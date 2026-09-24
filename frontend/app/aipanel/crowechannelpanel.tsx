// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { createBlock } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
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
        name: "Look around this workspace",
        scope: "Reads your terminal and files, then tells you what matters",
        prompt: "Inspect this workspace and tell me what matters right now.",
    },
    {
        id: "code",
        name: "Plan a code change",
        scope: "Opens the code editor and proposes the next useful change",
        prompt: "Review the current project, identify the next useful code change, and make a concrete plan.",
        blockdef: { meta: { view: "crowecode" } },
    },
    {
        id: "research",
        name: "Research this project",
        scope: "Summarizes decisions with links to the sources",
        prompt: "Research this project context and summarize the decision points with source references.",
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
            <div className="text-[12px] text-[var(--text-dim)]">
                {widgetAccess ? "Try one of these" : "Try one of these (turn tools on so Hypheus can see your work)"}
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
                            <div className="text-[13px] text-[var(--text)] group-hover:text-[var(--accent)]">
                                {channel.name}
                            </div>
                            <div className="mt-0.5 text-[12px] leading-snug text-[var(--text-dim)]">
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
