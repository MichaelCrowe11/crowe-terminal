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
import { CHAT_DEFAULT_WIDTH, DOCK_DEFAULT_WIDTH, DOCK_RAIL_WIDTH, DockModel, DockToolId } from "./dock-model";
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

const DOCK_COMPACT_BREAKPOINT = 900;

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
    const width = useAtomValue(model.widthAtom);
    const chatWidth = useAtomValue(model.chatWidthAtom);
    const chatOpen = useAtomValue(layout.panelVisibleAtom);
    const waveAI = WaveAIModel.getInstance();
    const aiMode = useAtomValue(waveAI.currentAIMode);
    const aiConfigs = useAtomValue(waveAI.aiModeConfigs);
    const modelLabel = aiConfigs?.[aiMode]?.["display:name"] ?? "Model";
    const dragMode = useRef<"tool" | "chat" | null>(null);
    const [theme, setTheme] = useState<AppTheme>(() => getAppTheme());

    const toggleChat = useCallback(() => {
        const nextOpen = !layout.getAIPanelVisible();
        if (nextOpen && window.innerWidth < DOCK_COMPACT_BREAKPOINT) {
            model.collapse();
        }
        layout.setAIPanelVisible(nextOpen);
    }, [layout, model]);

    const toggleTool = useCallback(
        (id: DockToolId) => {
            if (window.innerWidth < DOCK_COMPACT_BREAKPOINT && layout.getAIPanelVisible()) {
                layout.setAIPanelVisible(false);
            }
            model.toggle(id);
        },
        [layout, model]
    );

    const toggleTheme = useCallback(() => {
        setTheme((currentTheme) => {
            const nextTheme = currentTheme === "dark" ? "light" : "dark";
            applyAppTheme(nextTheme);
            return nextTheme;
        });
    }, []);

    const onToolResizeDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragMode.current = "tool";
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    const onChatResizeDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragMode.current = "chat";
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (dragMode.current === "tool") {
                const toolOffset = DOCK_RAIL_WIDTH + (chatOpen ? chatWidth : 0);
                model.setWidth(e.clientX - toolOffset);
            } else if (dragMode.current === "chat") {
                model.setChatWidth(e.clientX - DOCK_RAIL_WIDTH);
            }
        };
        const onUp = () => {
            if (dragMode.current == null) {
                return;
            }
            dragMode.current = null;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
    }, [chatOpen, chatWidth, model]);

    useEffect(() => {
        VcsModel.getInstance().startPolling();
    }, []);

    const activeDef = !collapsed && activeTool ? DOCK_TOOLS.find((t) => t.id === activeTool) : null;
    const ActivePanel = activeDef?.Panel;
    // Tool drawers extend to the right of the chat drawer when it's open so the
    // two floating panels never stack on top of each other.
    const toolLeft = chatOpen ? DOCK_RAIL_WIDTH + chatWidth : DOCK_RAIL_WIDTH;

    return (
        <div className="crowe-dock-root">
            <aside
                className={cn(
                    "crowe-dock-drawer crowe-chat-drawer glass-chrome glass-grain",
                    !chatOpen && "crowe-chat-drawer-closed"
                )}
                style={{ width: chatOpen ? chatWidth : 0 }}
                aria-hidden={!chatOpen}
            >
                <div
                    className="crowe-dock-resize crowe-dock-resize-grip"
                    role="separator"
                    aria-orientation="vertical"
                    title="Drag to resize, double-click to reset"
                    onMouseDown={onChatResizeDown}
                    onDoubleClick={() => model.setChatWidth(CHAT_DEFAULT_WIDTH)}
                />
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
            </aside>
            {activeDef && ActivePanel && (
                <aside className="crowe-dock-drawer glass-chrome glass-grain" style={{ width, left: toolLeft }}>
                    <div
                        className="crowe-dock-resize"
                        role="separator"
                        aria-orientation="vertical"
                        title="Drag to resize, double-click to reset"
                        onMouseDown={onToolResizeDown}
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
            <nav className="crowe-dock-rail glass-chrome" aria-label="Hypheus operator tools">
                <div className="crowe-dock-brand" title="Hypheus operator tools" aria-hidden="true">
                    <img src={hypheusMark} alt="" />
                </div>
                <span className="crowe-dock-sep" />
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
                            onClick={() => toggleTool(tool.id)}
                            title={tool.label}
                            aria-label={tool.label}
                            aria-pressed={isActive}
                        >
                            {isActive && <span className="crowe-dock-indicator" />}
                            <tool.Icon className="crowe-dock-glyph" />
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
                    {theme === "dark" ? (
                        <SunIcon className="crowe-dock-glyph" />
                    ) : (
                        <MoonIcon className="crowe-dock-glyph" />
                    )}
                </button>
            </nav>
        </div>
    );
});
UtilityDockElem.displayName = "UtilityDock";

export { UtilityDockElem as UtilityDock };
