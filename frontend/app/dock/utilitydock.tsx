// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef } from "react";
import { AssistantIcon, CloseIcon, HyphaeIcon, NetworkIcon, NibIcon, SporeIcon, VitalsIcon } from "./crowe-icons";
import { DesignReviewModel } from "./designreview-model";
import { DOCK_DEFAULT_WIDTH, DOCK_RAIL_WIDTH, DockModel, DockToolId } from "./dock-model";
import "./dock.scss";
import { DesignPanel, ModelPanel, MyceliumPanel, TelemetryPanel, ThinkingPanel } from "./dockpanels";

interface DockTool {
    id: DockToolId;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    Panel: React.ComponentType;
}

const DOCK_TOOLS: DockTool[] = [
    { id: "telemetry", label: "Vitals", Icon: VitalsIcon, Panel: TelemetryPanel },
    { id: "model", label: "Model", Icon: SporeIcon, Panel: ModelPanel },
    { id: "thinking", label: "Cognition", Icon: HyphaeIcon, Panel: ThinkingPanel },
    { id: "design", label: "Design review", Icon: NibIcon, Panel: DesignPanel },
    { id: "mycelium", label: "Mycelium", Icon: NetworkIcon, Panel: MyceliumPanel },
];

const DesignBadge = memo(() => {
    const count = useAtomValue(DesignReviewModel.getInstance().openCountAtom);
    if (count <= 0) {
        return null;
    }
    return <span className="crowe-dock-badge">{count > 99 ? 99 : count}</span>;
});
DesignBadge.displayName = "DesignBadge";

const UtilityDockElem = memo(() => {
    const model = DockModel.getInstance();
    const layout = WorkspaceLayoutModel.getInstance();
    const activeTool = useAtomValue(model.activeToolAtom);
    const collapsed = useAtomValue(model.collapsedAtom);
    const width = useAtomValue(model.widthAtom);
    const chatOpen = useAtomValue(layout.panelVisibleAtom);
    const dragging = useRef(false);

    const toggleChat = useCallback(() => {
        layout.setAIPanelVisible(!layout.getAIPanelVisible());
    }, [layout]);

    const onResizeDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragging.current = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!dragging.current) {
                return;
            }
            model.setWidth(window.innerWidth - e.clientX - DOCK_RAIL_WIDTH);
        };
        const onUp = () => {
            if (!dragging.current) {
                return;
            }
            dragging.current = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
    }, [model]);

    const activeDef = !collapsed && activeTool ? DOCK_TOOLS.find((t) => t.id === activeTool) : null;
    const ActivePanel = activeDef?.Panel;

    return (
        <div className="crowe-dock-root">
            {activeDef && ActivePanel && (
                <aside className="crowe-dock-drawer glass-chrome glass-grain" style={{ width }}>
                    <div
                        className="crowe-dock-resize"
                        role="separator"
                        aria-orientation="vertical"
                        title="Drag to resize, double-click to reset"
                        onMouseDown={onResizeDown}
                        onDoubleClick={() => model.setWidth(DOCK_DEFAULT_WIDTH)}
                    />
                    <div className="crowe-dock-head">
                        <span className="crowe-dock-title">{activeDef.label}</span>
                        <button
                            type="button"
                            className="crowe-dock-close cursor-pointer"
                            onClick={() => model.collapse()}
                            title="Collapse panel"
                            aria-label="Collapse panel"
                        >
                            <CloseIcon />
                        </button>
                    </div>
                    <div className="crowe-dock-body">
                        <ActivePanel />
                    </div>
                </aside>
            )}
            <nav className="crowe-dock-rail glass-chrome" aria-label="Utility tools">
                <button
                    type="button"
                    className={cn("crowe-dock-btn cursor-pointer", chatOpen && "crowe-dock-btn-active")}
                    onClick={toggleChat}
                    title={chatOpen ? "Close assistant" : "Open assistant"}
                    aria-label="Toggle assistant"
                    aria-pressed={chatOpen}
                >
                    {chatOpen && <span className="crowe-dock-indicator" />}
                    <AssistantIcon className="crowe-dock-glyph" />
                </button>
                <span className="crowe-dock-sep" />
                {DOCK_TOOLS.map((tool) => {
                    const isActive = activeTool === tool.id && !collapsed;
                    return (
                        <button
                            key={tool.id}
                            type="button"
                            className={cn("crowe-dock-btn cursor-pointer", isActive && "crowe-dock-btn-active")}
                            onClick={() => model.toggle(tool.id)}
                            title={tool.label}
                            aria-label={tool.label}
                            aria-pressed={isActive}
                        >
                            {isActive && <span className="crowe-dock-indicator" />}
                            <tool.Icon className="crowe-dock-glyph" />
                            {tool.id === "design" && <DesignBadge />}
                        </button>
                    );
                })}
            </nav>
        </div>
    );
});
UtilityDockElem.displayName = "UtilityDock";

export { UtilityDockElem as UtilityDock };
