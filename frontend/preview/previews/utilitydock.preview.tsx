// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import hypheusWordmark from "@/app/asset/hypheus-wordmark.svg?url";
import { DockModel } from "@/app/dock/dock-model";
import { UtilityDock } from "@/app/dock/utilitydock";
import { VcsModel } from "@/app/dock/vcs-model";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { cn } from "@/util/util";
import { useEffect, useState } from "react";

const terminalRows = [
    ["~/Projects/hypheus", "git status --short"],
    ["", "M frontend/app/dock/utilitydock.tsx"],
    ["", "M frontend/app/dock/dock.scss"],
    ["~/Projects/hypheus", "go test ./pkg/agent/..."],
    ["", "ok   github.com/wavetermdev/waveterm/pkg/agent"],
];

// UtilityDock's own child effect (VcsModel.startPolling) fires before this
// file's component effects do, and there is no wavesrv in the preview to
// answer the RPC, so the flag must be set here at module scope -- before
// getInstance() and before any component mounts -- rather than in an effect.
VcsModel.fetchDisabled = true;
const vcsModel = VcsModel.getInstance();
globalStore.set(vcsModel.statusAtom, {
    installed: true,
    isrepo: true,
    dir: "/Users/mike/Projects/hypheus",
    root: "/Users/mike/Projects/hypheus",
    clean: false,
    files: [
        { path: "frontend/app/dock/utilitydock.tsx", changes: 12, plus: 9, minus: 3 },
        { path: "pkg/jj/jj.go", changes: 4, plus: 4, minus: 0 },
    ],
});
globalStore.set(vcsModel.historyAtom, [
    { opid: "f0302bfacf0f", description: "snapshot working copy", time: "2026-08-09 07:05:33", timerel: "2 minutes ago" },
    { opid: "902af479a0b1", description: "snapshot working copy", time: "2026-08-09 06:51:10", timerel: "16 minutes ago" },
    { opid: "8c1d22aa90ef", description: "restore to operation 44f1", time: "2026-08-09 06:40:02", timerel: "27 minutes ago" },
    { opid: "44f19c0be2d1", description: "snapshot working copy", time: "2026-08-09 06:12:44", timerel: "55 minutes ago" },
]);

// Stand-in for a real block: enough chrome (header, terminal text, footer)
// that reflow under a shrinking column is visible, not just a resized rectangle.
const BlockArea = () => (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-panel px-4">
            <img src={hypheusWordmark} alt="Hypheus" className="h-5 w-auto" />
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                phoenix / operator
            </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-5 font-mono text-xs">
            <div className="mb-5 flex items-center justify-between border-b border-border pb-3 text-muted">
                <span>hypheus / main</span>
                <span>zsh</span>
            </div>
            <div className="space-y-2">
                {terminalRows.map(([prompt, output], index) => (
                    <div key={index} className={prompt ? "text-foreground" : "text-muted"}>
                        {prompt && <span className="mr-2 text-accent">{prompt} %</span>}
                        {output}
                    </div>
                ))}
                <div className="mt-3 flex items-center text-foreground">
                    <span className="mr-2 text-accent">~/Projects/hypheus %</span>
                    <span className="h-4 w-2 bg-accent" />
                </div>
            </div>
        </div>
        <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-panel px-3 font-mono text-[10px] text-muted">
            <span>main</span>
            <span>local / arm64</span>
        </footer>
    </div>
);

// DockModel and WorkspaceLayoutModel are singletons, so four live UtilityDock
// instances would fight over one piece of shared state. Render one case at a
// time (selected below) instead of laying all four out side by side.
const DockCase = ({ label, chat, tool }: { label: string; chat: boolean; tool: boolean }) => {
    useEffect(() => {
        const dock = DockModel.getInstance();
        const layout = WorkspaceLayoutModel.getInstance();
        globalStore.set(layout.panelVisibleAtom, chat);
        globalStore.set(dock.activeToolAtom, tool ? "repo" : null);
        globalStore.set(dock.collapsedAtom, !tool);
    }, [chat, tool]);

    return (
        <figure className="flex min-w-0 flex-1 flex-col gap-2">
            <figcaption className="font-mono text-[10px] uppercase text-muted">{label}</figcaption>
            <div className="flex h-[520px] overflow-hidden border border-border bg-background shadow-xl">
                <UtilityDock />
                <BlockArea />
            </div>
        </figure>
    );
};

const CASES = [
    { label: "chat only", chat: true, tool: false },
    { label: "tool only", chat: false, tool: true },
    { label: "both, split", chat: true, tool: true },
    { label: "collapsed", chat: false, tool: false },
];

export default function UtilityDockPreview() {
    const [caseIdx, setCaseIdx] = useState(2);
    const c = CASES[caseIdx];
    return (
        <div className="flex w-[min(1180px,calc(100vw-32px))] flex-col gap-3">
            <div className="flex gap-2">
                {CASES.map((x, i) => (
                    <button
                        key={x.label}
                        type="button"
                        className={cn(
                            "cursor-pointer border border-border px-2 py-1 font-mono text-[10px] uppercase",
                            i === caseIdx ? "bg-accent/80 text-primary" : "text-muted"
                        )}
                        onClick={() => setCaseIdx(i)}
                    >
                        {x.label}
                    </button>
                ))}
            </div>
            <DockCase label={c.label} chat={c.chat} tool={c.tool} />
        </div>
    );
}
