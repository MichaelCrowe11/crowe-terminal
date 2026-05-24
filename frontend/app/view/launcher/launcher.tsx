// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import croweMarkUrl from "@/app/asset/crowe-mark.png?url";
import croweWordmarkUrl from "@/app/asset/crowe-wordmark.svg?url";
import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atoms, globalStore, replaceBlock } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { checkKeyPressed, keydownWrapper } from "@/util/keyutil";
import { isBlank, makeIconClass } from "@/util/util";
import clsx from "clsx";
import { atom, useAtom, useAtomValue } from "jotai";
import React, { useEffect, useLayoutEffect, useRef } from "react";

function sortByDisplayOrder(wmap: { [key: string]: WidgetConfigType } | null | undefined): WidgetConfigType[] {
    if (!wmap) return [];
    const wlist = Object.values(wmap);
    wlist.sort((a, b) => (a["display:order"] ?? 0) - (b["display:order"] ?? 0));
    return wlist;
}

type GridLayoutType = { columns: number; tileWidth: number; tileHeight: number; showLabel: boolean };

type WorkspaceAction = {
    id: string;
    eyebrow: string;
    name: string;
    tagline: string;
    status: string;
    blockdef: BlockDef;
};

const CROWE_WEB_IDE_URL = "https://crowecode-web-production.up.railway.app/ide?surface=crowe-terminal";

const WORKSPACE_ACTIONS: WorkspaceAction[] = [
    {
        id: "account",
        eyebrow: "Account",
        name: "Sign in",
        tagline: "Use the managed Crowe Logic workspace. No API keys or model setup.",
        status: "secure",
        // Temporary fallback while crowecode.com DNS/TLS is being finalized.
        blockdef: { meta: { view: "web", url: "https://www.crowelogic.com/account" } },
    },
    {
        id: "crowecode-web",
        eyebrow: "Web IDE",
        name: "CroweCode Web",
        tagline: "Run the live CroweCode workspace natively inside Crowe Terminal.",
        status: "native",
        blockdef: { meta: { view: "web", url: CROWE_WEB_IDE_URL } },
    },
    {
        id: "code",
        eyebrow: "Editor",
        name: "Crowe Code",
        tagline: "Open files, diffs, and implementation tools inside the terminal.",
        status: "local",
        blockdef: { meta: { view: "crowecode" } },
    },
    {
        id: "files",
        eyebrow: "Workspace",
        name: "Files",
        tagline: "Browse a folder. Click a file to open it in Crowe Code.",
        status: "local",
        blockdef: { meta: { view: "crowecode-explorer" } },
    },
    {
        id: "problems",
        eyebrow: "Diagnostics",
        name: "Problems",
        tagline: "Live errors, warnings, and hints across every open file.",
        status: "live",
        blockdef: { meta: { view: "crowecode-problems" } },
    },
    {
        id: "crowelm",
        eyebrow: "Operator",
        name: "CroweLM panel",
        tagline: "Work through code, research, files, terminal context, and grow ops channels.",
        status: "managed",
        blockdef: { meta: { view: "waveai" } },
    },
];

type Stat = { value: string; label: string };

const STATS: Stat[] = [
    { value: "signed", label: "Account workspace" },
    { value: "managed", label: "CroweLM routing" },
    { value: "local", label: "Terminal tools" },
    { value: "no keys", label: "Provider setup" },
];

function getGreeting(): string {
    const h = new Date().getHours();
    if (h < 5) return "Late night";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    if (h < 21) return "Good evening";
    return "Late night";
}

export class LauncherViewModel implements ViewModel {
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewType = "launcher";
    viewIcon = atom("shapes");
    viewName = atom("Crowe Terminal");
    viewComponent = LauncherView;
    noHeader = atom(true);
    inputRef = { current: null } as React.RefObject<HTMLInputElement>;
    searchTerm = atom("");
    selectedIndex = atom(0);
    containerSize = atom({ width: 0, height: 0 });
    gridLayout: GridLayoutType = null;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
    }

    filteredWidgetsAtom = atom((get) => {
        const searchTerm = get(this.searchTerm);
        const widgets = sortByDisplayOrder(get(atoms.fullConfigAtom)?.widgets || {});
        return widgets.filter(
            (widget) =>
                !widget["display:hidden"] &&
                (!searchTerm || widget.label?.toLowerCase().includes(searchTerm.toLowerCase()))
        );
    });

    giveFocus(): boolean {
        if (this.inputRef.current) {
            this.inputRef.current.focus();
            return true;
        }
        return false;
    }

    keyDownHandler(e: WaveKeyboardEvent): boolean {
        if (this.gridLayout == null) {
            return;
        }
        const gridLayout = this.gridLayout;
        const filteredWidgets = globalStore.get(this.filteredWidgetsAtom);
        const selectedIndex = globalStore.get(this.selectedIndex);
        const rows = Math.ceil(filteredWidgets.length / gridLayout.columns);
        const currentRow = Math.floor(selectedIndex / gridLayout.columns);
        const currentCol = selectedIndex % gridLayout.columns;
        if (checkKeyPressed(e, "ArrowUp")) {
            if (filteredWidgets.length == 0) {
                return true;
            }
            if (currentRow > 0) {
                const newIndex = selectedIndex - gridLayout.columns;
                if (newIndex >= 0) {
                    globalStore.set(this.selectedIndex, newIndex);
                }
            }
            return true;
        }
        if (checkKeyPressed(e, "ArrowDown")) {
            if (filteredWidgets.length == 0) {
                return true;
            }
            if (currentRow < rows - 1) {
                const newIndex = selectedIndex + gridLayout.columns;
                if (newIndex < filteredWidgets.length) {
                    globalStore.set(this.selectedIndex, newIndex);
                }
            }
            return true;
        }
        if (checkKeyPressed(e, "ArrowLeft")) {
            if (filteredWidgets.length == 0) {
                return true;
            }
            if (currentCol > 0) {
                globalStore.set(this.selectedIndex, selectedIndex - 1);
            }
            return true;
        }
        if (checkKeyPressed(e, "ArrowRight")) {
            if (filteredWidgets.length == 0) {
                return true;
            }
            if (currentCol < gridLayout.columns - 1 && selectedIndex + 1 < filteredWidgets.length) {
                globalStore.set(this.selectedIndex, selectedIndex + 1);
            }
            return true;
        }
        if (checkKeyPressed(e, "Enter")) {
            if (filteredWidgets.length == 0) {
                return true;
            }
            if (filteredWidgets[selectedIndex]) {
                this.handleWidgetSelect(filteredWidgets[selectedIndex]);
            }
            return true;
        }
        if (checkKeyPressed(e, "Escape")) {
            globalStore.set(this.searchTerm, "");
            globalStore.set(this.selectedIndex, 0);
            return true;
        }
        return false;
    }

    async handleWidgetSelect(widget: WidgetConfigType) {
        try {
            await replaceBlock(this.blockId, widget.blockdef, true);
        } catch (error) {
            console.error("Error replacing block:", error);
        }
    }

    async handleProductSelect(blockdef: BlockDef) {
        try {
            await replaceBlock(this.blockId, blockdef, true);
        } catch (error) {
            console.error("Error replacing block (product):", error);
        }
    }
}

function LauncherView({ blockId, model }: ViewComponentProps<LauncherViewModel>) {
    // Search and selection state
    const [searchTerm, setSearchTerm] = useAtom(model.searchTerm);
    const [selectedIndex, setSelectedIndex] = useAtom(model.selectedIndex);
    const filteredWidgets = useAtomValue(model.filteredWidgetsAtom);

    // Container measurement
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerSize, setContainerSize] = useAtom(model.containerSize);

    useLayoutEffect(() => {
        if (!containerRef.current) return;
        const resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                setContainerSize({
                    width: entry.contentRect.width,
                    height: entry.contentRect.height,
                });
            }
        });
        resizeObserver.observe(containerRef.current);
        return () => {
            resizeObserver.disconnect();
        };
    }, []);

    // Layout constants
    const GAP = 16;
    const LABEL_THRESHOLD = 60;
    const MARGIN_BOTTOM = 24;
    const MAX_TILE_SIZE = 120;

    const calculatedLogoWidth = containerSize.width * 0.3;
    const logoWidth = containerSize.width >= 100 ? Math.min(Math.max(calculatedLogoWidth, 100), 300) : 0;
    const showLogo = logoWidth >= 100;
    const availableHeight = containerSize.height - (showLogo ? logoWidth + MARGIN_BOTTOM : 0);

    // Determine optimal grid layout
    const gridLayout: GridLayoutType = React.useMemo(() => {
        if (containerSize.width === 0 || availableHeight <= 0 || filteredWidgets.length === 0) {
            return { columns: 1, tileWidth: 90, tileHeight: 90, showLabel: true };
        }
        let bestColumns = 1;
        let bestTileSize = 0;
        let bestTileWidth = 90;
        let bestTileHeight = 90;
        let showLabel = true;
        for (let cols = 1; cols <= filteredWidgets.length; cols++) {
            const rows = Math.ceil(filteredWidgets.length / cols);
            const tileWidth = (containerSize.width - (cols - 1) * GAP) / cols;
            const tileHeight = (availableHeight - (rows - 1) * GAP) / rows;
            const currentTileSize = Math.min(tileWidth, tileHeight);
            if (currentTileSize > bestTileSize) {
                bestTileSize = currentTileSize;
                bestColumns = cols;
                bestTileWidth = tileWidth;
                bestTileHeight = tileHeight;
                showLabel = tileHeight >= LABEL_THRESHOLD;
            }
        }
        return { columns: bestColumns, tileWidth: bestTileWidth, tileHeight: bestTileHeight, showLabel };
    }, [containerSize, availableHeight, filteredWidgets.length]);
    model.gridLayout = gridLayout;

    const finalTileWidth = Math.min(gridLayout.tileWidth, MAX_TILE_SIZE);
    const finalTileHeight = gridLayout.showLabel ? Math.min(gridLayout.tileHeight, MAX_TILE_SIZE) : finalTileWidth;

    // Reset selection when search term changes
    useEffect(() => {
        setSelectedIndex(0);
    }, [searchTerm]);

    return (
        <div ref={containerRef} className="relative w-full h-full p-5 box-border flex flex-col items-center justify-center overflow-auto bg-[#0b0b0c]">
            {showLogo && (
                <div className="relative mb-5 flex flex-col items-center gap-3" style={{ width: logoWidth, maxWidth: 360 }}>
                    <div className="inline-flex items-center gap-2 border border-[#bfa669]/30 bg-[#bfa669]/[0.04] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[#bfa669]">
                        <span className="h-1 w-1 animate-pulse bg-[#bfa669]" />
                        Signed workspace
                    </div>
                    <img src={croweWordmarkUrl} className="h-auto w-full max-w-[260px]" alt="Crowe Logic" />
                    <img src={croweMarkUrl} className="h-auto w-full max-w-[58px]" alt="" />
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#bfa669]/60">
                        {getGreeting()} · terminal · code · CroweLM
                    </div>
                </div>
            )}

            <div className="relative mb-6 w-full max-w-md">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-[#bfa669]/70">
                    {">"}
                </span>
                <input
                    ref={model.inputRef}
                    type="text"
                    value={searchTerm}
                    onKeyDown={keydownWrapper(model.keyDownHandler.bind(model))}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="SEARCH TOOLS AND WORKSPACES"
                    aria-label="Search widgets"
                    className="w-full border border-[#bfa669]/20 bg-[#0b0b0c]/70 py-2.5 pl-8 pr-3 font-mono text-[11px] uppercase tracking-[0.16em] text-[#e8e2cf] placeholder:text-[#e8e2cf]/35 focus:border-[#bfa669]/55 focus:outline-none focus:ring-2 focus:ring-[#bfa669]/15 transition-colors"
                />
            </div>

            <div className="relative mb-8 grid w-full max-w-3xl gap-3 grid-cols-1 md:grid-cols-3">
                {WORKSPACE_ACTIONS.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        onClick={() => model.handleProductSelect(p.blockdef)}
                        className="group flex cursor-pointer flex-col items-start gap-2 border border-[#bfa669]/15 bg-[#bfa669]/[0.025] p-4 text-left transition-colors hover:border-[#bfa669]/45 hover:bg-[#bfa669]/[0.06]"
                    >
                        <div className="flex w-full items-center justify-between">
                            <span className="font-mono text-[10px] uppercase tracking-[0.20em] text-[#bfa669]">
                                {p.eyebrow}
                            </span>
                            <span
                                className={clsx(
                                    "inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.18em]",
                                    "text-[#bfa669]/70"
                                )}
                            >
                                <span
                                    className={clsx(
                                        "h-1 w-1",
                                        p.status === "secure" ? "bg-[#e8e2cf]/65" : "bg-[#bfa669] animate-pulse"
                                    )}
                                />
                                {p.status}
                            </span>
                        </div>
                        <span className="text-[14px] font-bold text-[#e8e2cf]">{p.name}</span>
                        <span className="text-[12px] leading-relaxed text-[#e8e2cf]/55">{p.tagline}</span>
                        <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#bfa669]/0 transition-colors group-hover:text-[#bfa669]/80">
                            open →
                        </span>
                    </button>
                ))}
            </div>

            {filteredWidgets.length > 0 && (
                <div className="relative mb-3 flex items-center gap-3">
                    <span className="h-px w-12 bg-[#bfa669]/20" />
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#bfa669]/55">
                        Or jump to a tool
                    </span>
                    <span className="h-px w-12 bg-[#bfa669]/20" />
                </div>
            )}

            <div
                className="relative grid gap-4 justify-center"
                style={{
                    gridTemplateColumns: `repeat(${gridLayout.columns}, ${finalTileWidth}px)`,
                }}
            >
                {filteredWidgets.map((widget, index) => (
                    <div
                        key={index}
                        onClick={() => model.handleWidgetSelect(widget)}
                        title={widget.description || widget.label}
                        className={clsx(
                            "flex flex-col items-center justify-center cursor-pointer p-2 text-center",
                            "border transition-colors duration-150",
                            index === selectedIndex
                                ? "border-[#bfa669]/60 bg-[#bfa669]/[0.12] text-[#e8e2cf]"
                                : "border-[#bfa669]/15 bg-[#bfa669]/[0.03] text-[#e8e2cf]/70 hover:border-[#bfa669]/40 hover:bg-[#bfa669]/[0.07] hover:text-[#e8e2cf]"
                        )}
                        style={{
                            width: finalTileWidth,
                            height: finalTileHeight,
                        }}
                    >
                        <div style={{ color: widget.color }}>
                            <i
                                className={makeIconClass(widget.icon, true, {
                                    defaultIcon: "browser",
                                })}
                            />
                        </div>
                        {gridLayout.showLabel && !isBlank(widget.label) && (
                            <div className="mt-1 w-full text-[11px] leading-4 overflow-hidden text-ellipsis whitespace-nowrap">
                                {widget.label}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            <div className="relative mt-8 grid w-full max-w-2xl grid-cols-2 gap-4 border-t border-[#bfa669]/10 pt-5 md:grid-cols-4">
                {STATS.map((s) => (
                    <div key={s.label} className="flex flex-col items-center gap-0.5 text-center">
                        <span className="font-mono text-[16px] font-bold tracking-tight text-[#bfa669]">{s.value}</span>
                        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#e8e2cf]/40">
                            {s.label}
                        </span>
                    </div>
                ))}
            </div>

            <div className="relative mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-[#e8e2cf]/40">
                {filteredWidgets.length === 0 ? (
                    <span>no widgets found · esc to clear</span>
                ) : (
                    <span>↵ launch · ← ↑ → ↓ navigate{searchTerm ? ` · matched "${searchTerm}"` : ""}</span>
                )}
            </div>
        </div>
    );
}

export default LauncherView;
