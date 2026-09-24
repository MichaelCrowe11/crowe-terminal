// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AIPanel } from "@/app/aipanel/aipanel";
import hypheusMark from "@/app/asset/hypheus-mark.png";
import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { applyAppTheme, AppTheme, getAppTheme } from "@/app/theme/app-theme";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { debounce } from "throttle-debounce";
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
    DOCK_MIN_WIDTH,
    DOCK_RAIL_WIDTH,
    DOCK_SPLIT_PX,
    TOOL_DEFAULT_WIDTH,
    TOOL_MIN_WIDTH,
    resolveDockWidths,
    keyboardResizeWidth,
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
    { id: "telemetry", label: "Run telemetry", Icon: VitalsIcon, Panel: TelemetryPanel },
    { id: "model", label: "Engines", Icon: SporeIcon, Panel: ModelPanel },
    { id: "thinking", label: "Activity", Icon: HyphaeIcon, Panel: ThinkingPanel },
    { id: "design", label: "Design review", Icon: NibIcon, Panel: DesignPanel },
    { id: "mycelium", label: "Workspace", Icon: NetworkIcon, Panel: MyceliumPanel },
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
    const toolWidth = useAtomValue(model.toolWidthAtom);
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

    const activeDef = !collapsed && activeTool ? DOCK_TOOLS.find((t) => t.id === activeTool) : null;
    const ActivePanel = activeDef?.Panel;
    const toolOpen = activeDef != null && ActivePanel != null;
    const [parentWidth, setParentWidth] = useState(0);
    const sizes = resolveDockWidths(parentWidth, columnWidth, toolWidth, chatOpen, toolOpen);
    const columnOpen = sizes.showChat || sizes.showTool;
    // The tool column only occupies space when both panes are showing; on its
    // own it is the whole column and flexes instead of holding a fixed width.
    const toolAllowance = sizes.showChat && sizes.showTool ? sizes.tool + DOCK_SPLIT_PX : 0;
    const dragStyles = useRef<{ cursor: string; userSelect: string }>(null);

    const toggleChat = useCallback(() => {
        if (sizes.compact) {
            model.collapse();
            return;
        }
        layout.setAIPanelVisible(!layout.getAIPanelVisible());
    }, [layout, model, sizes.compact]);

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
        if (e.button !== 0) return;
        e.preventDefault();
        dragStyles.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
        dragMode.current = "column";
        setDragging(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    const onSplitDown = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragStyles.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
        dragMode.current = "split";
        setDragging(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    // The CSS max-width: 70% on .crowe-dock-column resolves against
    // .crowe-dock-root, which has no definite width of its own, so it cannot
    // be relied on to keep block area usable. This measures the actual
    // available space (the workspace row), and subtracts whatever the tool
    // column is holding so the clamp bounds the chat pane rather than the pair.
    const resizePane = useCallback((tool: boolean, px: number, commit = false) => {
        if (tool) {
            model.setToolWidth(Math.min(px, sizes.toolMax));
        } else {
            model.setColumnWidth(Math.min(px, sizes.columnMax));
        }
        if (commit) model.commitPersist();
    }, [model, sizes.toolMax, sizes.columnMax]);
    const onResizeKey = (e: React.KeyboardEvent, tool: boolean) => {
        const max = tool ? sizes.toolMax : sizes.columnMax;
        const value = keyboardResizeWidth(e.key, e.shiftKey, tool ? sizes.tool : sizes.column,
            Math.min(tool ? TOOL_MIN_WIDTH : DOCK_MIN_WIDTH, max), max,
            tool ? TOOL_DEFAULT_WIDTH : DOCK_DEFAULT_WIDTH);
        if (value == null) return;
        e.preventDefault();
        e.stopPropagation();
        resizePane(tool, value, true);
    };

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (dragMode.current === "column") {
                // The grip sits on the outer edge, so the pointer measures the
                // whole dock; the tool column's share is not the chat's to take.
                const chatPx = e.clientX - (rootRef.current?.getBoundingClientRect().left ?? 0) - DOCK_RAIL_WIDTH - toolAllowance;
                resizePane(!sizes.showChat, chatPx);
                return;
            }
            if (dragMode.current !== "split") {
                return;
            }
            resizePane(true, e.clientX - (rootRef.current?.getBoundingClientRect().left ?? 0) - DOCK_RAIL_WIDTH);
        };
        const onUp = () => {
            if (dragMode.current == null) {
                return;
            }
            dragMode.current = null;
            setDragging(false);
            document.body.style.cursor = dragStyles.current?.cursor ?? "";
            document.body.style.userSelect = dragStyles.current?.userSelect ?? "";
            dragStyles.current = null;
            model.commitPersist();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        window.addEventListener("blur", onUp);
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            window.removeEventListener("blur", onUp);
        };
    }, [model, resizePane, sizes.showChat, toolAllowance]);

    useEffect(() => () => {
        if (dragStyles.current == null) return;
        document.body.style.cursor = dragStyles.current.cursor;
        document.body.style.userSelect = dragStyles.current.userSelect;
        model.commitPersist();
    }, [model]);

    // Shrinking the window does not fire mousemove, so an already-wide column
    // needs its own re-clamp on resize to keep blocks above MIN_BLOCK_PX.
    useEffect(() => {
        const measure = () => setParentWidth(rootRef.current?.parentElement?.getBoundingClientRect().width ?? 0);
        const onResize = debounce(100, measure);
        measure();
        const observer = new ResizeObserver(measure);
        if (rootRef.current?.parentElement) observer.observe(rootRef.current.parentElement);
        window.addEventListener("resize", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
            // Without this a trailing call can land after unmount and write a
            // width measured against a layout that no longer exists.
            onResize.cancel();
            observer.disconnect();
        };
    }, []);

    // Opening a tool widens the dock by a whole column, which can push blocks
    // under MIN_BLOCK_PX without any window resize to trigger the other clamp.
    useEffect(() => {
        setParentWidth(rootRef.current?.parentElement?.getBoundingClientRect().width ?? 0);
    }, [toolOpen, chatOpen]);

    useEffect(() => {
        VcsModel.getInstance().startPolling();
    }, []);

    const toolPaneStyle = sizes.showChat
        ? { flex: `0 0 ${sizes.tool}px`, minWidth: 0 }
        : { flex: "1 1 auto", minWidth: 0 };
    const chatPaneStyle = { flex: "1 1 auto", minWidth: 0 };
    const dockWidth = sizes.column + sizes.tool + (sizes.showChat && sizes.showTool ? DOCK_SPLIT_PX : 0);

    return (
        <div className="crowe-dock-root" ref={rootRef}>
            <nav className="crowe-dock-rail crowe-instrument-surface" aria-label="Hypheus operator tools">
                <div className="crowe-dock-brand" title="Hypheus operator tools" aria-hidden="true">
                    <img src={hypheusMark} alt="" />
                </div>
                <span className="crowe-dock-sep" />
                <button
                    type="button"
                    className={cn("crowe-dock-btn cursor-pointer", sizes.showChat && "crowe-dock-btn-active")}
                    onClick={toggleChat}
                    title={sizes.showChat ? "Hide operator" : "Show operator"}
                    aria-label={sizes.showChat ? "Hide operator" : "Show operator"}
                    aria-pressed={sizes.showChat}
                >
                    <AssistantIcon className="crowe-dock-glyph" />
                    {sizes.showChat && <span className="crowe-dock-indicator" />}
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
                    "crowe-dock-column crowe-instrument-surface",
                    dragging && "crowe-dock-dragging",
                    !columnOpen && "crowe-dock-column-closed"
                )}
                style={{ width: dockWidth }}
            >
                {toolOpen && (
                    <section id="crowe-tool-pane" className="crowe-dock-pane crowe-dock-pane-tool" style={toolPaneStyle}>
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
                            {sizes.compact && <div className="crowe-panel-hint">Compact view. Close this tool to return to the operator. An active run continues.</div>}
                            <ActivePanel />
                        </div>
                    </section>
                )}
                {sizes.showChat && sizes.showTool && (
                    <div
                        className="crowe-dock-split"
                        role="separator"
                        tabIndex={0}
                        aria-label="Tool panel width"
                        aria-controls="crowe-tool-pane"
                        aria-valuemin={Math.min(TOOL_MIN_WIDTH, sizes.toolMax)}
                        aria-valuemax={sizes.toolMax}
                        aria-valuenow={sizes.tool}
                        aria-valuetext={`${sizes.tool} pixels`}
                        aria-orientation="vertical"
                        title="Drag or use arrow keys to resize. Enter or double-click to reset."
                        onKeyDown={(e) => onResizeKey(e, true)}
                        onMouseDown={onSplitDown}
                        onDoubleClick={() => resizePane(true, TOOL_DEFAULT_WIDTH, true)}
                    />
                )}
                {/* The AI panel stays mounted while hidden so a close/reopen does not discard
                    the conversation, reload it over RPC, or truncate a response mid-stream. */}
                <section
                    id="crowe-operator-pane"
                    className="crowe-dock-pane"
                    style={{ ...chatPaneStyle, display: sizes.showChat ? "flex" : "none" }}
                    aria-hidden={!sizes.showChat}
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
                            title="Close operator"
                            aria-label="Close operator"
                        >
                            <CloseIcon />
                        </button>
                    </div>
                    <div className="crowe-chat-body">
                        <AIPanel roundTopLeft={false} />
                    </div>
                </section>
                <div
                    className="crowe-dock-resize crowe-dock-resize-grip"
                    role="separator"
                    tabIndex={columnOpen ? 0 : -1}
                    aria-hidden={!columnOpen}
                    aria-label={sizes.showChat ? "Operator panel width" : "Tool panel width"}
                    aria-controls={sizes.showChat ? "crowe-operator-pane" : "crowe-tool-pane"}
                    aria-valuemin={sizes.showChat ? Math.min(DOCK_MIN_WIDTH, sizes.columnMax) : Math.min(TOOL_MIN_WIDTH, sizes.toolMax)}
                    aria-valuemax={sizes.showChat ? sizes.columnMax : sizes.toolMax}
                    aria-valuenow={sizes.showChat ? sizes.column : sizes.tool}
                    aria-valuetext={`${sizes.showChat ? sizes.column : sizes.tool} pixels`}
                    aria-orientation="vertical"
                    title="Drag or use arrow keys to resize. Enter or double-click to reset."
                    onKeyDown={(e) => onResizeKey(e, !sizes.showChat)}
                    onMouseDown={onColumnResizeDown}
                    onDoubleClick={() => resizePane(!sizes.showChat, sizes.showChat ? DOCK_DEFAULT_WIDTH : TOOL_DEFAULT_WIDTH, true)}
                />
            </div>
        </div>
    );
});
UtilityDockElem.displayName = "UtilityDock";

export { UtilityDockElem as UtilityDock };
