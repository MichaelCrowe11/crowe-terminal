// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AIPanel } from "@/app/aipanel/aipanel";
import hypheusMark from "@/app/asset/hypheus-mark.png";
import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { applyAppTheme, AppTheme, getAppTheme } from "@/app/theme/app-theme";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
    AssistantIcon,
    CloseIcon,
    HyphaeIcon,
    MoonIcon,
    NetworkIcon,
    NibIcon,
    RingsIcon,
    SporeIcon,
    SunIcon,
    VitalsIcon,
} from "./crowe-icons";
import { DesignReviewModel } from "./designreview-model";
import {
    DOCK_DEFAULT_WIDTH,
    DOCK_MAX_WIDTH,
    DOCK_MIN_WIDTH,
    DOCK_RAIL_WIDTH,
    DEFAULT_CHAT_FRACTION,
    MIN_BLOCK_PX,
    DockModel,
    DockToolId,
} from "./dock-model";
import "./dock.scss";
import { DesignPanel, ModelPanel, MyceliumPanel, TelemetryPanel, ThinkingPanel, VcsPanel } from "./dockpanels";
import { VcsModel } from "./vcs-model";

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
    { id: "repo", label: "Repository", Icon: RingsIcon, Panel: VcsPanel },
];

const DesignBadge = memo(() => {
    const count = useAtomValue(DesignReviewModel.getInstance().openCountAtom);
    if (count <= 0) {
        return null;
    }
    return <span className="crowe-dock-badge">{count > 99 ? 99 : count}</span>;
});
DesignBadge.displayName = "DesignBadge";

const VcsDirtyPip = memo(() => {
    const dirty = useAtomValue(VcsModel.getInstance().dirtyAtom);
    if (!dirty) {
        return null;
    }
    return <span className="crowe-dock-pip" />;
});
VcsDirtyPip.displayName = "VcsDirtyPip";

const UtilityDockElem = memo(() => {
    const model = DockModel.getInstance();
    const layout = WorkspaceLayoutModel.getInstance();
    const activeTool = useAtomValue(model.activeToolAtom);
    const collapsed = useAtomValue(model.collapsedAtom);
    const columnWidth = useAtomValue(model.columnWidthAtom);
    const chatFraction = useAtomValue(model.chatFractionAtom);
    const columnRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState(false);
    const chatOpen = useAtomValue(layout.panelVisibleAtom);
    const waveAI = WaveAIModel.getInstance();
    const aiMode = useAtomValue(waveAI.currentAIMode);
    const aiConfigs = useAtomValue(waveAI.aiModeConfigs);
    const modelLabel = aiConfigs?.[aiMode]?.["display:name"] ?? "Model";
    const dragMode = useRef<"column" | "split" | null>(null);
    const [theme, setTheme] = useState<AppTheme>(() => getAppTheme());

    const toggleChat = useCallback(() => {
        layout.setAIPanelVisible(!layout.getAIPanelVisible());
    }, [layout]);

    const toggleTool = useCallback(
        (id: DockToolId) => {
            model.toggle(id);
        },
        [model]
    );

    const toggleTheme = useCallback(() => {
        setTheme((currentTheme) => {
            const nextTheme = currentTheme === "dark" ? "light" : "dark";
            applyAppTheme(nextTheme);
            return nextTheme;
        });
    }, []);

    const onColumnResizeDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragMode.current = "column";
        setDragging(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    const onSplitDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragMode.current = "split";
        setDragging(true);
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
    }, []);

    // The CSS max-width: 70% on .crowe-dock-column resolves against
    // .crowe-dock-root, which has no definite width of its own, so it cannot
    // be relied on to keep block area usable. This measures the actual
    // available space (the workspace row) the same way chatFraction is
    // clamped against a measured column height.
    const maxColumnWidth = useCallback(() => {
        const parentWidth = rootRef.current?.parentElement?.getBoundingClientRect().width;
        if (parentWidth == null || parentWidth <= 0) {
            return DOCK_MAX_WIDTH;
        }
        return Math.max(DOCK_MIN_WIDTH, parentWidth - DOCK_RAIL_WIDTH - MIN_BLOCK_PX);
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (dragMode.current === "column") {
                model.setColumnWidth(Math.min(e.clientX - DOCK_RAIL_WIDTH, maxColumnWidth()));
                return;
            }
            if (dragMode.current !== "split") {
                return;
            }
            const rect = columnRef.current?.getBoundingClientRect();
            if (rect == null || rect.height === 0) {
                return;
            }
            model.setChatFraction((e.clientY - rect.top) / rect.height, rect.height);
        };
        const onUp = () => {
            if (dragMode.current == null) {
                return;
            }
            dragMode.current = null;
            setDragging(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
    }, [model, maxColumnWidth]);

    // Shrinking the window does not fire mousemove, so an already-wide column
    // needs its own re-clamp on resize to keep blocks above MIN_BLOCK_PX.
    useEffect(() => {
        const onResize = () => {
            model.setColumnWidth(Math.min(globalStore.get(model.columnWidthAtom), maxColumnWidth()));
        };
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
        };
    }, [model, maxColumnWidth]);

    useEffect(() => {
        VcsModel.getInstance().startPolling();
    }, []);

    const activeDef = !collapsed && activeTool ? DOCK_TOOLS.find((t) => t.id === activeTool) : null;
    const ActivePanel = activeDef?.Panel;
    const toolOpen = activeDef != null && ActivePanel != null;
    const columnOpen = chatOpen || toolOpen;

    const chatPaneStyle = toolOpen
        ? { flexGrow: chatFraction, flexBasis: 0, minHeight: 0 }
        : { flex: "1 1 auto", minHeight: 0 };
    const toolPaneStyle = chatOpen
        ? { flexGrow: 1 - chatFraction, flexBasis: 0, minHeight: 0 }
        : { flex: "1 1 auto", minHeight: 0 };

    return (
        <div className="crowe-dock-root" ref={rootRef}>
            <nav className="crowe-dock-rail glass-chrome" aria-label="Hypheus operator tools">
                <div className="crowe-dock-brand" title="Hypheus operator tools" aria-hidden="true">
                    <img src={hypheusMark} alt="" />
                </div>
                <span className="crowe-dock-sep" />
                <button
                    type="button"
                    className={cn("crowe-dock-btn cursor-pointer", chatOpen && "crowe-dock-btn-active")}
                    onClick={toggleChat}
                    title={chatOpen ? "Hide assistant" : "Assistant"}
                    aria-label={chatOpen ? "Hide assistant" : "Assistant"}
                    aria-pressed={chatOpen}
                >
                    <AssistantIcon className="crowe-dock-glyph" />
                    {chatOpen && <span className="crowe-dock-indicator" />}
                </button>
                {DOCK_TOOLS.map((tool) => {
                    const isActive = !collapsed && activeTool === tool.id;
                    return (
                        <button
                            key={tool.id}
                            type="button"
                            className={cn("crowe-dock-btn cursor-pointer", isActive && "crowe-dock-btn-active")}
                            onClick={() => toggleTool(tool.id)}
                            title={tool.label}
                            aria-label={tool.label}
                            aria-pressed={isActive}
                        >
                            <tool.Icon className="crowe-dock-glyph" />
                            {isActive && <span className="crowe-dock-indicator" />}
                            {tool.id === "design" && <DesignBadge />}
                            {tool.id === "repo" && <VcsDirtyPip />}
                        </button>
                    );
                })}
                <span className="crowe-dock-grow" />
                <span className="crowe-dock-sep" />
                <button
                    type="button"
                    className="crowe-dock-btn cursor-pointer"
                    onClick={toggleTheme}
                    title={theme === "dark" ? "Use light theme" : "Use dark theme"}
                    aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
                    aria-pressed={theme === "light"}
                >
                    {theme === "dark" ? <SunIcon className="crowe-dock-glyph" /> : <MoonIcon className="crowe-dock-glyph" />}
                </button>
            </nav>
            <div
                ref={columnRef}
                className={cn(
                    "crowe-dock-column glass-chrome glass-grain",
                    dragging && "crowe-dock-dragging",
                    !columnOpen && "crowe-dock-column-closed"
                )}
                style={{ width: columnOpen ? columnWidth : 0 }}
            >
                {/* The AI panel stays mounted while hidden so a close/reopen does not discard
                    the conversation, reload it over RPC, or truncate a response mid-stream. */}
                <section
                    className="crowe-dock-pane"
                    style={{ ...chatPaneStyle, display: chatOpen ? "flex" : "none" }}
                    aria-hidden={!chatOpen}
                >
                    <div className="crowe-dock-head crowe-chat-head">
                        <button
                            type="button"
                            className="crowe-chat-model cursor-pointer"
                            onClick={() => toggleTool("model")}
                            title="Switch model"
                        >
                            <span className="crowe-chat-model-dot" />
                            <span className="crowe-chat-model-name">{modelLabel}</span>
                            <i className="fa fa-angle-down crowe-chat-model-caret" />
                        </button>
                        <button
                            type="button"
                            className="crowe-dock-close cursor-pointer"
                            onClick={() => layout.setAIPanelVisible(false)}
                            title="Close assistant"
                            aria-label="Close assistant"
                        >
                            <CloseIcon />
                        </button>
                    </div>
                    <div className="crowe-chat-body">
                        <AIPanel roundTopLeft={false} />
                    </div>
                </section>
                {chatOpen && toolOpen && (
                    <div
                        className="crowe-dock-split"
                        role="separator"
                        aria-orientation="horizontal"
                        title="Drag to resize, double-click to reset"
                        onMouseDown={onSplitDown}
                        onDoubleClick={() => model.setChatFraction(DEFAULT_CHAT_FRACTION)}
                    />
                )}
                {toolOpen && (
                    <section className="crowe-dock-pane" style={toolPaneStyle}>
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
                    </section>
                )}
                <div
                    className="crowe-dock-resize crowe-dock-resize-grip"
                    role="separator"
                    aria-orientation="vertical"
                    title="Drag to resize, double-click to reset"
                    onMouseDown={onColumnResizeDown}
                    onDoubleClick={() => model.setColumnWidth(DOCK_DEFAULT_WIDTH)}
                />
            </div>
        </div>
    );
});
UtilityDockElem.displayName = "UtilityDock";

export { UtilityDockElem as UtilityDock };
