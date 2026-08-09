// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import hypheusWordmark from "@/app/asset/hypheus-wordmark.svg?url";
import { DockModel } from "@/app/dock/dock-model";
import { UtilityDock } from "@/app/dock/utilitydock";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { useEffect } from "react";

const terminalRows = [
    ["~/Projects/hypheus", "git status --short"],
    ["", "M frontend/app/dock/utilitydock.tsx"],
    ["", "M frontend/app/dock/dock.scss"],
    ["~/Projects/hypheus", "go test ./pkg/agent/..."],
    ["", "ok   github.com/wavetermdev/waveterm/pkg/agent"],
];

export default function UtilityDockPreview() {
    useEffect(() => {
        const dock = DockModel.getInstance();
        const layout = WorkspaceLayoutModel.getInstance();
        globalStore.set(layout.panelVisibleAtom, false);
        globalStore.set(dock.activeToolAtom, "telemetry");
        globalStore.set(dock.collapsedAtom, false);
    }, []);

    return (
        <div className="flex h-[720px] w-[min(1180px,calc(100vw-32px))] overflow-hidden border border-border bg-background shadow-xl">
            <UtilityDock />
            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-panel px-4">
                    <img src={hypheusWordmark} alt="Hypheus" className="h-5 w-auto" />
                    <div className="flex items-center gap-2 font-mono text-[10px] uppercase text-muted">
                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                        phoenix / operator
                    </div>
                </header>
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-border md:grid-cols-[minmax(0,1fr)_300px]">
                    <div className="min-w-0 bg-background p-5 font-mono text-xs">
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
                    <aside className="hidden min-w-0 bg-panel p-4 md:block">
                        <div className="text-[10px] uppercase text-muted">Workspace</div>
                        <div className="mt-4 space-y-3 font-mono text-xs">
                            <div className="border-l-2 border-accent pl-3 text-foreground">operator-tools</div>
                            <div className="border-l-2 border-transparent pl-3 text-muted">agent-runtime</div>
                            <div className="border-l-2 border-transparent pl-3 text-muted">preview</div>
                        </div>
                    </aside>
                </div>
                <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-panel px-3 font-mono text-[10px] text-muted">
                    <span>main</span>
                    <span>local / arm64</span>
                </footer>
            </section>
            <nav
                className="flex w-12 shrink-0 flex-col items-center gap-2 border-l border-border bg-panel py-2"
                aria-label="Workspace widgets"
            >
                <button className="flex h-9 w-9 items-center justify-center rounded-md text-accent" title="Terminal">
                    <i className="fa-sharp fa-light fa-terminal" />
                </button>
                <button className="flex h-9 w-9 items-center justify-center rounded-md text-muted" title="Editor">
                    <i className="fa-sharp fa-light fa-code" />
                </button>
                <button className="flex h-9 w-9 items-center justify-center rounded-md text-muted" title="Web">
                    <i className="fa-sharp fa-light fa-globe" />
                </button>
                <button className="flex h-9 w-9 items-center justify-center rounded-md text-muted" title="Files">
                    <i className="fa-sharp fa-light fa-folder" />
                </button>
            </nav>
        </div>
    );
}
