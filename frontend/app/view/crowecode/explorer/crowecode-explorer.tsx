// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useMemo, useState } from "react";
import type { CroweCodeExplorerViewModel, ExplorerEntry } from "./crowecode-explorer-model";

type RowProps = {
    entry: ExplorerEntry;
    depth: number;
    expanded: boolean;
    loading: boolean;
    onToggleDir: (path: string) => void;
    onOpenFile: (path: string) => void;
};

const ExplorerRow = memo(({ entry, depth, expanded, loading, onToggleDir, onOpenFile }: RowProps) => {
    const handleClick = () => {
        if (entry.isDir) {
            onToggleDir(entry.path);
        } else {
            onOpenFile(entry.path);
        }
    };
    const icon = entry.isDir
        ? loading
            ? "fa-circle-notch fa-spin"
            : expanded
              ? "fa-folder-open"
              : "fa-folder"
        : "fa-file";
    return (
        <button
            type="button"
            onClick={handleClick}
            className={cn(
                "w-full text-left flex items-center gap-1.5 px-2 py-0.5 text-[12px] text-[#e8e2cf]/80",
                "hover:bg-[#bfa669]/[0.10] hover:text-[#e8e2cf] cursor-pointer transition-colors",
                "font-mono"
            )}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            title={entry.path}
        >
            {entry.isDir ? (
                <i
                    className={cn(
                        "fa fa-caret-right text-[10px] text-[#bfa669]/60 w-2 transition-transform",
                        expanded && "rotate-90"
                    )}
                />
            ) : (
                <span className="w-2" />
            )}
            <i className={cn("fa text-[11px]", icon, entry.isDir ? "text-[#bfa669]/85" : "text-[#e8e2cf]/55")} />
            <span className="truncate">{entry.name}</span>
        </button>
    );
});
ExplorerRow.displayName = "ExplorerRow";

// Flatten the recursive (root + expanded children) tree into a single ordered
// list of {entry, depth} so the render is straightforward.
function flattenTree(
    root: string,
    entriesMap: Map<string, ExplorerEntry[]>,
    expanded: Set<string>
): { entry: ExplorerEntry; depth: number }[] {
    const out: { entry: ExplorerEntry; depth: number }[] = [];
    function walk(dir: string, depth: number) {
        const entries = entriesMap.get(dir);
        if (!entries) return;
        for (const entry of entries) {
            out.push({ entry, depth });
            if (entry.isDir && expanded.has(entry.path)) {
                walk(entry.path, depth + 1);
            }
        }
    }
    walk(root, 0);
    return out;
}

export const CroweCodeExplorerView: React.FC<ViewComponentProps<CroweCodeExplorerViewModel>> = ({ model, contentRef }) => {
    const root = useAtomValue(model.rootAtom);
    const entries = useAtomValue(model.entriesAtom);
    const expanded = useAtomValue(model.expandedAtom);
    const loading = useAtomValue(model.loadingAtom);
    const error = useAtomValue(model.errorAtom);
    const [pendingRoot, setPendingRoot] = useState("");

    // Auto-load root contents whenever root changes (initial mount and after
    // openRoot writes the meta).
    useEffect(() => {
        if (!root) return;
        if (entries.has(root)) return;
        void model.loadDir(root);
    }, [root, entries, model]);

    const rows = useMemo(() => (root ? flattenTree(root, entries, expanded) : []), [root, entries, expanded]);

    if (!root) {
        return (
            <div ref={contentRef} className="flex flex-col h-full w-full p-4 gap-3 bg-[#0b0b0c]/40">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#bfa669]/70">
                    Open Folder
                </div>
                <p className="text-[11px] text-[#e8e2cf]/55 leading-snug">
                    Type an absolute path (e.g. <code className="font-mono text-[#bfa669]/85">~/Projects/crowe-terminal</code>) and hit return. This block will track that folder; other Crowe Code blocks pick it up automatically.
                </p>
                <input
                    type="text"
                    value={pendingRoot}
                    onChange={(e) => setPendingRoot(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && pendingRoot.trim()) {
                            void model.openRoot(pendingRoot.trim());
                        }
                    }}
                    placeholder="/Users/you/Projects/your-repo"
                    className="font-mono text-[12px] text-[#e8e2cf] bg-[#0b0b0c]/80 border border-[#bfa669]/30 px-3 py-2 outline-none focus:border-[#bfa669]/60"
                />
                <button
                    type="button"
                    disabled={!pendingRoot.trim()}
                    onClick={() => void model.openRoot(pendingRoot.trim())}
                    className={cn(
                        "self-start border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors",
                        pendingRoot.trim()
                            ? "border-[#bfa669]/40 bg-[#bfa669]/[0.06] text-[#bfa669] hover:bg-[#bfa669]/[0.12] cursor-pointer"
                            : "border-zinc-700 bg-transparent text-zinc-500 cursor-default"
                    )}
                >
                    Open Folder
                </button>
            </div>
        );
    }

    return (
        <div ref={contentRef} className="flex flex-col h-full w-full bg-[#0b0b0c]/40 overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center justify-between px-2 py-1.5 border-b border-[#bfa669]/15 bg-[#0b0b0c]/90 backdrop-blur">
                <span
                    className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-[#bfa669]/75"
                    title={root}
                >
                    {root.split("/").pop() || root}
                </span>
                <button
                    type="button"
                    onClick={() => model.refresh()}
                    title="Refresh"
                    className="text-[#bfa669]/60 hover:text-[#bfa669] text-[11px] px-1 cursor-pointer transition-colors"
                >
                    <i className="fa fa-rotate-right" />
                </button>
            </div>
            {error && (
                <div className="px-2 py-1 text-[11px] text-red-400 font-mono">{error}</div>
            )}
            <div className="py-1">
                {rows.map(({ entry, depth }) => (
                    <ExplorerRow
                        key={entry.path}
                        entry={entry}
                        depth={depth}
                        expanded={expanded.has(entry.path)}
                        loading={loading.has(entry.path)}
                        onToggleDir={(p) => void model.toggleDir(p)}
                        onOpenFile={(p) => void model.openFile(p)}
                    />
                ))}
                {rows.length === 0 && !loading.has(root) && (
                    <div className="px-3 py-2 text-[11px] text-[#e8e2cf]/45 font-mono">empty</div>
                )}
            </div>
        </div>
    );
};

CroweCodeExplorerView.displayName = "CroweCodeExplorerView";
