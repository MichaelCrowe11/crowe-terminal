// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { ViewComponentProps } from "@/app/block/blocktypes";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import type { CroweCodeProblemsViewModel, ProblemEntry } from "./crowecode-problems-model";

const SEVERITY_STYLES: Record<ProblemEntry["severityLabel"], { icon: string; tone: string }> = {
    error: { icon: "fa-circle-xmark", tone: "text-red-400" },
    warning: { icon: "fa-triangle-exclamation", tone: "text-amber-300" },
    info: { icon: "fa-circle-info", tone: "text-sky-300" },
    hint: { icon: "fa-lightbulb", tone: "text-[#bfa669]/80" },
};

function fileLabel(resource: string): string {
    // file:///Users/x/Projects/y/src/foo.ts -> src/foo.ts (best-effort short)
    const u = resource.replace(/^file:\/\//, "");
    const parts = u.split("/");
    if (parts.length <= 3) return u;
    return parts.slice(-3).join("/");
}

type RowProps = {
    entry: ProblemEntry;
    onClick: (entry: ProblemEntry) => void;
};

const ProblemRow = memo(({ entry, onClick }: RowProps) => {
    const style = SEVERITY_STYLES[entry.severityLabel];
    return (
        <button
            type="button"
            onClick={() => onClick(entry)}
            className={cn(
                "w-full text-left flex items-start gap-2 px-3 py-1.5 text-[12px] text-[#e8e2cf]/85",
                "hover:bg-[#bfa669]/[0.08] cursor-pointer transition-colors font-mono",
                "border-b border-[#bfa669]/10"
            )}
            title={`${entry.resource}:${entry.startLine}:${entry.startColumn}`}
        >
            <i className={cn("fa text-[11px] mt-[3px]", style.icon, style.tone)} />
            <div className="min-w-0 flex-1">
                <div className="truncate text-[#e8e2cf]/90">{entry.message}</div>
                <div className="truncate text-[10px] text-[#bfa669]/60 mt-0.5">
                    {fileLabel(entry.resource)}
                    <span className="text-[#e8e2cf]/40"> · {entry.startLine}:{entry.startColumn}</span>
                    {entry.source && <span className="text-[#e8e2cf]/40"> · {entry.source}</span>}
                </div>
            </div>
        </button>
    );
});
ProblemRow.displayName = "ProblemRow";

export const CroweCodeProblemsView: React.FC<ViewComponentProps<CroweCodeProblemsViewModel>> = ({ model, contentRef }) => {
    const problems = useAtomValue(model.problemsAtom);
    const counts = useMemo(() => {
        const c = { error: 0, warning: 0, info: 0, hint: 0 };
        for (const p of problems) c[p.severityLabel] += 1;
        return c;
    }, [problems]);

    return (
        <div ref={contentRef} className="flex flex-col h-full w-full bg-[#0b0b0c]/40 overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center gap-3 px-3 py-1.5 border-b border-[#bfa669]/15 bg-[#0b0b0c]/90 backdrop-blur">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#bfa669]/75">
                    Problems
                </span>
                <span className="font-mono text-[10px] text-[#e8e2cf]/55">
                    {counts.error} err · {counts.warning} warn · {counts.info + counts.hint} info
                </span>
            </div>
            {problems.length === 0 ? (
                <div className="px-3 py-6 text-[11px] text-[#e8e2cf]/45 font-mono text-center">
                    No problems detected.
                    <div className="mt-1 text-[10px] text-[#e8e2cf]/30">
                        Open files in Crowe Code to surface diagnostics.
                    </div>
                </div>
            ) : (
                <div>
                    {problems.map((p, i) => (
                        <ProblemRow
                            key={`${p.resource}:${p.startLine}:${p.startColumn}:${i}`}
                            entry={p}
                            onClick={(e) => void model.openProblem(e)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

CroweCodeProblemsView.displayName = "CroweCodeProblemsView";
