// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { WaveAIModel } from "@/app/aipanel/waveai-model";
import croweMarkUrl from "@/app/asset/hypheus-mark.png?url";
import croweWordmarkUrl from "@/app/asset/hypheus-wordmark.svg?url";
import type { BlockNodeModel } from "@/app/block/blocktypes";
import { DockModel } from "@/app/dock/dock-model";
import { atoms, globalStore, replaceBlock } from "@/app/store/global";
import type { TabModel } from "@/app/store/tab-model";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { checkKeyPressed, keydownWrapper } from "@/util/keyutil";
import { cn, makeIconClass } from "@/util/util";
import { atom, Atom, PrimitiveAtom, useAtom, useAtomValue } from "jotai";
import React, { useEffect } from "react";
import "./launcher.scss";

function sortByDisplayOrder(wmap: { [key: string]: WidgetConfigType } | null | undefined): WidgetConfigType[] {
    if (!wmap) return [];
    const wlist = Object.values(wmap);
    wlist.sort((a, b) => (a["display:order"] ?? 0) - (b["display:order"] ?? 0));
    return wlist;
}

type WorkspaceAction = {
    id: string;
    name: string;
    tagline: string;
    blockdef: BlockDef;
};

const WorkspaceActions: WorkspaceAction[] = [
    {
        id: "account",
        name: "Connect account",
        tagline: "Connect Crowe ID from the operator panel.",
        // Crowe ID account console (Keycloak realm "crowe"); crowelogic.com/account does not exist.
        // Use panel setup because the account console alone cannot authenticate model requests.
        blockdef: { meta: { view: "waveai" } },
    },
    {
        id: "code",
        name: "Crowe Code",
        tagline: "Open the editor.",
        blockdef: { meta: { view: "crowecode" } },
    },
    {
        id: "files",
        name: "Files",
        tagline: "Browse a folder.",
        blockdef: { meta: { view: "crowecode-explorer" } },
    },
    {
        id: "problems",
        name: "Problems",
        tagline: "Inspect editor diagnostics.",
        blockdef: { meta: { view: "crowecode-problems" } },
    },
    {
        id: "crowelm",
        name: "Operator panel",
        tagline: "Work with terminal and file context.",
        blockdef: { meta: { view: "waveai" } },
    },
];

export class LauncherViewModel implements ViewModel {
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewType = "launcher";
    viewIcon = atom("shapes");
    viewName = atom("Hypheus");
    viewComponent = LauncherView;
    noHeader = atom(true);
    inputRef = { current: null } as React.RefObject<HTMLInputElement>;
    searchTerm: PrimitiveAtom<string> = atom("");
    selectedIndex: PrimitiveAtom<number> = atom(0);
    toolRefs: HTMLButtonElement[] = [];
    filteredWidgetsAtom: Atom<WidgetConfigType[]>;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.filteredWidgetsAtom = atom((get) => {
            const searchTerm = get(this.searchTerm).trim().toLowerCase();
            const widgets = sortByDisplayOrder(get(atoms.fullConfigAtom)?.widgets || {});
            return widgets.filter(
                (widget) =>
                    !widget["display:hidden"] &&
                    (!searchTerm ||
                        `${widget.label ?? ""} ${widget.description ?? ""}`.toLowerCase().includes(searchTerm))
            );
        });
    }

    giveFocus(): boolean {
        if (this.inputRef.current) {
            this.inputRef.current.focus();
            return true;
        }
        return false;
    }

    keyDownHandler(e: WaveKeyboardEvent): boolean {
        const focusedTool = this.toolRefs.findIndex((tool) => tool != null && tool === document.activeElement);
        const searchFocused = this.inputRef.current === document.activeElement;
        if (!searchFocused && focusedTool < 0) {
            return false;
        }
        const filteredWidgets = globalStore.get(this.filteredWidgetsAtom);
        if (checkKeyPressed(e, "Escape")) {
            globalStore.set(this.searchTerm, "");
            globalStore.set(this.selectedIndex, 0);
            this.giveFocus();
            return true;
        }
        if (checkKeyPressed(e, "ArrowDown") || checkKeyPressed(e, "ArrowUp")) {
            if (filteredWidgets.length === 0) {
                return true;
            }
            const direction = checkKeyPressed(e, "ArrowDown") ? 1 : -1;
            const nextIndex = searchFocused
                ? direction === 1
                    ? 0
                    : filteredWidgets.length - 1
                : Math.min(filteredWidgets.length - 1, Math.max(0, focusedTool + direction));
            globalStore.set(this.selectedIndex, nextIndex);
            this.toolRefs[nextIndex]?.focus();
            return true;
        }
        if (searchFocused && checkKeyPressed(e, "Enter")) {
            const selectedIndex = globalStore.get(this.selectedIndex);
            if (filteredWidgets[selectedIndex]) {
                void this.handleWidgetSelect(filteredWidgets[selectedIndex]);
            }
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

export function LauncherView({ model }: ViewComponentProps<LauncherViewModel>) {
    // Search and selection state
    const [searchTerm, setSearchTerm] = useAtom(model.searchTerm);
    const [selectedIndex, setSelectedIndex] = useAtom(model.selectedIndex);
    const filteredWidgets = useAtomValue(model.filteredWidgetsAtom);

    // Container measurement
    // Layout constants
    // Determine optimal grid layout
    // Reset selection when search term changes
    useEffect(() => {
        setSelectedIndex(0);
    }, [searchTerm, filteredWidgets.length]);

    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (event.nativeEvent.isComposing) {
            return;
        }
        keydownWrapper(model.keyDownHandler.bind(model))(event);
    };

    return (
        <div className="crowe-launcher">
            <div className="crowe-launcher-content">
                <header className="crowe-launcher-header">
                    <img src={croweMarkUrl} className="crowe-launcher-mark" alt="" />
                    <img src={croweWordmarkUrl} className="crowe-launcher-wordmark" alt="Hypheus" />
                </header>
                <h1 className="crowe-launcher-title">Open your workspace</h1>
                <p className="crowe-launcher-subhead">Terminal, files, and code in one place.</p>
                <nav aria-label="Workspace destinations" className="crowe-launcher-destinations">
                    {WorkspaceActions.map((action) => (
                        <button
                            key={action.id}
                            type="button"
                            onClick={() => {
                                if (action.id === "account") {
                                    WaveAIModel.getInstance().openCroweAccount();
                                    return;
                                }
                                if (action.id === "crowelm") {
                                    DockModel.getInstance().collapse();
                                    WorkspaceLayoutModel.getInstance().setAIPanelVisible(true);
                                    return;
                                }
                                void model.handleProductSelect(action.blockdef);
                            }}
                            className="crowe-launcher-destination cursor-pointer"
                        >
                            <span className="crowe-launcher-name">{action.name}</span>
                            <span className="crowe-launcher-description">{action.tagline}</span>
                        </button>
                    ))}
                </nav>
                <section aria-label="Tools" className="crowe-launcher-tools">
                    <div className="crowe-launcher-search">
                        <input
                            ref={model.inputRef}
                            type="search"
                            value={searchTerm}
                            onKeyDown={handleKeyDown}
                            onChange={(e) => {
                                setSearchTerm(e.target.value);
                                setSelectedIndex(0);
                            }}
                            placeholder="Search tools"
                            aria-label="Search tools"
                            className="crowe-launcher-cmd"
                        />
                        {searchTerm && (
                            <button
                                type="button"
                                className="crowe-launcher-clear cursor-pointer"
                                onClick={() => {
                                    setSearchTerm("");
                                    setSelectedIndex(0);
                                    model.giveFocus();
                                }}
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    <p className="crowe-launcher-hint">Filter tools below by name or description.</p>
                    <div className="crowe-launcher-tool-list">
                        {filteredWidgets.map((widget, index) => (
                            <button
                                key={`${widget.label}-${widget.blockdef?.meta?.view}-${index}`}
                                ref={(element) => {
                                    model.toolRefs[index] = element;
                                }}
                                type="button"
                                onClick={() => void model.handleWidgetSelect(widget)}
                                onFocus={() => setSelectedIndex(index)}
                                onKeyDown={handleKeyDown}
                                title={widget.description || widget.label}
                                className={cn(
                                    "crowe-launcher-tool cursor-pointer",
                                    index === selectedIndex && "crowe-launcher-tool-active"
                                )}
                            >
                                <i
                                    aria-hidden="true"
                                    className={makeIconClass(widget.icon, true, { defaultIcon: "browser" })}
                                />
                                <span>{widget.label || widget.description || "Open tool"}</span>
                            </button>
                        ))}
                    </div>
                    {filteredWidgets.length === 0 && (
                        <p role="status" className="crowe-launcher-hint">
                            No matching tools. Clear the search to see all tools.
                        </p>
                    )}
                </section>
            </div>
        </div>
    );
}
