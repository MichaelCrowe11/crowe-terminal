// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { handleWaveAIContextMenu } from "@/app/aipanel/aipanel-contextmenu";
import { CroweCodeWorkspaceModel } from "@/app/view/crowecode/crowecode-workspace-model";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import { CroweAccountButton } from "./croweaccount";
import { WaveAIModel } from "./waveai-model";

export const AIPanelHeader = memo(({ onClose }: { onClose?: () => void }) => {
    const model = WaveAIModel.getInstance();
    const widgetAccess = useAtomValue(model.widgetAccessAtom);
    const isStreaming = useAtomValue(model.isAIStreaming);
    const currentMode = useAtomValue(model.currentAIMode);
    const configs = useAtomValue(model.aiModeConfigs);
    const engineLabel = configs?.[currentMode]?.["display:name"] ?? currentMode ?? "Choose engine";
    const inBuilder = model.inBuilder;
    const activeEditor = useAtomValue(CroweCodeWorkspaceModel.getInstance().activeEditorAtom);
    const activeLabel = useMemo(() => {
        if (!activeEditor) return null;
        const base = activeEditor.filePath.split("/").pop() || activeEditor.filePath;
        return `${base} · L${activeEditor.cursorLine}`;
    }, [activeEditor]);

    const handleKebabClick = (e: React.MouseEvent) => {
        handleWaveAIContextMenu(e, false);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        handleWaveAIContextMenu(e, false);
    };

    const toggleContext = () => {
        model.setWidgetAccess(!widgetAccess);
        setTimeout(() => model.focusInput(), 0);
    };

    // Temporary fallback while crowecode.com DNS/TLS is being finalized.

    return (
        <>
            <header className="crowe-operator-header" aria-label="Operator controls" onContextMenu={handleContextMenu}>
                {inBuilder ? (
                    <span className="crowe-operator-engine">App builder</span>
                ) : (
                    <button
                        type="button"
                        onClick={() => model.openEngineSelector()}
                        className="crowe-operator-engine cursor-pointer"
                        title={`Choose engine. Current engine: ${engineLabel}`}
                        aria-label={`Choose engine. Current engine: ${engineLabel}`}
                    >
                        <span className="min-w-0 truncate">{engineLabel}</span>
                        <i className="fa fa-angle-down shrink-0" aria-hidden="true" />
                    </button>
                )}
                <div className="crowe-operator-session-controls">
                    {!inBuilder && <CroweAccountButton onClick={() => model.openCroweAccount()} />}
                    <button
                        type="button"
                        onClick={() => model.clearChat()}
                        className="crowe-operator-icon cursor-pointer"
                        title="New chat"
                        aria-label="New chat"
                    >
                        <i className="fa fa-plus" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        onClick={handleKebabClick}
                        className="crowe-operator-icon cursor-pointer"
                        title="Session options"
                        aria-label="Session options"
                    >
                        <i className="fa fa-ellipsis-vertical" aria-hidden="true" />
                    </button>
                    {onClose && (
                        <button
                            type="button"
                            onClick={onClose}
                            className="crowe-operator-icon cursor-pointer"
                            title="Close operator"
                            aria-label="Close operator"
                        >
                            <i className="fa fa-xmark" aria-hidden="true" />
                        </button>
                    )}
                </div>
            </header>
            <div className="crowe-operator-authority" role="group" aria-label="Tool authority">
                {!inBuilder && (
                    <>
                        <span>Authority</span>
                        <button
                            type="button"
                            onClick={toggleContext}
                            title={
                                widgetAccess
                                    ? "Tools can read your terminal and files. Changes require approval. Turn tools off."
                                    : "Chat only. No terminal or file access. Enable tools."
                            }
                            aria-pressed={widgetAccess}
                            className={cn(
                                "crowe-authority-control cursor-pointer",
                                widgetAccess && "crowe-authority-enabled"
                            )}
                        >
                            {widgetAccess ? "Tools on" : "Chat only"}
                        </button>
                    </>
                )}
                <span className="crowe-operator-context" title={activeEditor?.filePath ?? undefined}>
                    {activeLabel ?? (widgetAccess ? "Changes require approval" : "No file or terminal access")}
                </span>
                {isStreaming && (
                    <span role="status" className="crowe-operator-run-state">
                        Running
                    </span>
                )}
            </div>
        </>
    );
});

AIPanelHeader.displayName = "AIPanelHeader";
