// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockModel } from "@/app/block/block-model";
import { recordTEvent } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useRef, useState } from "react";
import { WaveUIMessagePart } from "./aitypes";
import { RestoreBackupModal } from "./restorebackupmodal";
import { WaveAIModel } from "./waveai-model";

// matches pkg/filebackup/filebackup.go
const BackupRetentionDays = 5;

// Human labels for the tools a card can show. Keys are the tool id with "." and
// "-" folded to "_", so the agent-side "terminal.exec_safe" and the wire-side
// "terminal_exec_safe" resolve to the same line.
const ToolLabels: Record<string, string> = {
    terminal_exec_safe: "Ran a shell command",
    terminal_propose_command: "Proposed a command",
    terminal_list_blocks: "Listed the open blocks",
    terminal_read_scrollback: "Read terminal output",
    term_get_scrollback: "Read terminal output",
    term_command_output: "Read command output",
    read_dir: "Listed a directory",
    read_file: "Read a file",
    read_text_file: "Read a file",
    write_text_file: "Wrote a file",
    edit_text_file: "Edited a file",
    delete_text_file: "Deleted a file",
    capture_screenshot: "Captured a screenshot",
    widget_capture_screenshot: "Captured a screenshot",
    widget_focus: "Focused a block",
    widget_open_in_crowecode: "Opened in CroweCode",
    web_navigate: "Opened a page",
    web_search: "Searched the web",
    browser_navigate: "Opened a page",
    browser_in_window_navigate: "Opened a page",
    browser_in_window_read: "Read the page",
    browser_in_window_click: "Clicked in the page",
    browser_in_window_type: "Typed into the page",
    browser_in_window_screenshot: "Captured the page",
    system_metrics: "Read system metrics",
    system_run_applescript: "Ran AppleScript",
    system_tell_app: "Sent a command to an app",
    editor_read_file: "Read a file in the editor",
    editor_write_file: "Wrote a file in the editor",
    editor_apply_edit: "Applied an edit",
    vcs_status: "Checked repository status",
    vcs_diff: "Read the diff",
    vcs_checkpoint: "Saved a checkpoint",
    vcs_undo: "Reverted a checkpoint",
};

const ToolFamilies: Record<string, string> = {
    farm: "Farm",
    vcs: "Repository",
    editor: "Editor",
    browser: "Browser",
    builder: "Builder",
    allowlist: "Allowlist",
    system: "System",
    widget: "Block",
};

export function describeTool(toolName: string): string {
    const key = toolName.toLowerCase().replace(/[.-]/g, "_");
    const known = ToolLabels[key];
    if (known) {
        return known;
    }
    const words = key.split("_").filter(Boolean);
    if (words.length === 0) {
        return toolName;
    }
    const family = ToolFamilies[words[0]];
    const rest = (family ? words.slice(1) : words).join(" ");
    const phrase = rest.charAt(0).toUpperCase() + rest.slice(1);
    return family && phrase ? `${family}: ${phrase}` : phrase || toolName;
}

// The backend describes a call as "running <tool id>" while it is in flight;
// that repeats the label, so the card drops it.
function isRedundantDesc(desc: string | string[], toolName: string): boolean {
    const text = Array.isArray(desc) ? desc.join("\n") : desc;
    const fold = (s: string) => s.toLowerCase().replace(/[._\-\s]/g, "");
    return fold(text) === fold("running " + toolName);
}

interface StatusDotProps {
    status: string;
    className?: string;
}

const StatusDot = memo(({ status, className }: StatusDotProps) => {
    const tone =
        status === "completed"
            ? "bg-[var(--text-dim)]"
            : status === "error"
              ? "bg-[var(--crowe-error)]"
              : "border border-[var(--text-dim)] bg-transparent motion-safe:animate-pulse";
    return (
        <span
            aria-hidden="true"
            className={cn("inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full", tone, className)}
        />
    );
});

StatusDot.displayName = "StatusDot";

interface ToolDescLineProps {
    text: string;
}

const ToolDescLine = memo(({ text }: ToolDescLineProps) => {
    let displayText = text;
    if (displayText.startsWith("* ")) {
        displayText = "• " + displayText.slice(2);
    }

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const regex = /(?<!\w)([+-])(\d+)(?!\w)/g;
    let match;

    while ((match = regex.exec(displayText)) !== null) {
        if (match.index > lastIndex) {
            parts.push(displayText.slice(lastIndex, match.index));
        }

        const sign = match[1];
        const number = match[2];
        const colorClass = sign === "+" ? "text-success" : "text-error";
        parts.push(
            <span key={match.index} className={colorClass}>
                {sign}
                {number}
            </span>
        );

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < displayText.length) {
        parts.push(displayText.slice(lastIndex));
    }

    return <div>{parts.length > 0 ? parts : displayText}</div>;
});

ToolDescLine.displayName = "ToolDescLine";

interface ToolDescProps {
    text: string | string[];
    className?: string;
}

const ToolDesc = memo(({ text, className }: ToolDescProps) => {
    const lines = Array.isArray(text) ? text : text.split("\n");

    if (lines.length === 0) return null;

    return (
        <div className={className}>
            {lines.map((line, idx) => (
                <ToolDescLine key={idx} text={line} />
            ))}
        </div>
    );
});

ToolDesc.displayName = "ToolDesc";

function getEffectiveApprovalStatus(baseApproval: string, isStreaming: boolean): string {
    return !isStreaming && baseApproval === "needs-approval" ? "timeout" : baseApproval;
}

interface AIToolApprovalButtonsProps {
    count: number;
    onApprove: () => void;
    onDeny: () => void;
}

const AIToolApprovalButtons = memo(({ count, onApprove, onDeny }: AIToolApprovalButtonsProps) => {
    const approveText = count > 1 ? `Approve All (${count})` : "Approve";
    const denyText = count > 1 ? "Deny All" : "Deny";

    return (
        <div className="mt-2 flex items-center gap-2 border-t border-[var(--hairline-faint)] pt-2">
            <button
                onClick={onApprove}
                className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 py-1 text-[13px] font-medium text-[var(--accent-ink)] transition-colors hover:bg-[var(--accent-bright)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] cursor-pointer"
            >
                {approveText}
            </button>
            <button
                onClick={onDeny}
                className="rounded-[var(--radius-sm)] border border-[var(--hairline)] px-3 py-1 text-[13px] text-[var(--text-dim)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] cursor-pointer"
            >
                {denyText}
            </button>
        </div>
    );
});

AIToolApprovalButtons.displayName = "AIToolApprovalButtons";

interface AIToolUseBatchItemProps {
    part: WaveUIMessagePart & { type: "data-tooluse" };
    effectiveApproval: string;
}

const AIToolUseBatchItem = memo(({ part, effectiveApproval }: AIToolUseBatchItemProps) => {
    const effectiveErrorMessage = part.data.errormessage || (effectiveApproval === "timeout" ? "Not approved" : null);

    return (
        <div className="flex items-start gap-2 text-[13px]">
            <StatusDot status={part.data.status} className="mt-[6px]" />
            <div className="min-w-0 flex-1">
                <span className="text-[var(--text)]">{part.data.tooldesc}</span>
                {effectiveErrorMessage && (
                    <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">{effectiveErrorMessage}</div>
                )}
            </div>
        </div>
    );
});

AIToolUseBatchItem.displayName = "AIToolUseBatchItem";

interface AIToolUseBatchProps {
    parts: Array<WaveUIMessagePart & { type: "data-tooluse" }>;
    isStreaming: boolean;
}

const AIToolUseBatch = memo(({ parts, isStreaming }: AIToolUseBatchProps) => {
    const [userApprovalOverride, setUserApprovalOverride] = useState<string | null>(null);

    const firstTool = parts[0].data;
    const baseApproval = userApprovalOverride || firstTool.approval;
    const effectiveApproval = getEffectiveApprovalStatus(baseApproval, isStreaming);

    const handleApprove = () => {
        setUserApprovalOverride("user-approved");
        parts.forEach((part) => {
            WaveAIModel.getInstance().toolUseSendApproval(part.data.toolcallid, "user-approved");
        });
    };

    const handleDeny = () => {
        setUserApprovalOverride("user-denied");
        parts.forEach((part) => {
            WaveAIModel.getInstance().toolUseSendApproval(part.data.toolcallid, "user-denied");
        });
    };

    return (
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--surface-raised)] p-2 [box-shadow:inset_0_1px_0_var(--hair-top)]">
            <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
                    Reading files
                </div>
                <div className="mt-1.5 space-y-1">
                    {parts.map((part, idx) => (
                        <AIToolUseBatchItem key={idx} part={part} effectiveApproval={effectiveApproval} />
                    ))}
                </div>
                {effectiveApproval === "needs-approval" && (
                    <AIToolApprovalButtons count={parts.length} onApprove={handleApprove} onDeny={handleDeny} />
                )}
            </div>
        </div>
    );
});

AIToolUseBatch.displayName = "AIToolUseBatch";

interface AIToolUseProps {
    part: WaveUIMessagePart & { type: "data-tooluse" };
    isStreaming: boolean;
}

const AIToolUse = memo(({ part, isStreaming }: AIToolUseProps) => {
    const toolData = part.data;
    const [userApprovalOverride, setUserApprovalOverride] = useState<string | null>(null);
    const model = WaveAIModel.getInstance();
    const restoreModalToolCallId = useAtomValue(model.restoreBackupModalToolCallId);
    const showRestoreModal = restoreModalToolCallId === toolData.toolcallid;
    const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const highlightedBlockIdRef = useRef<string | null>(null);

    const toolLabel = describeTool(toolData.toolname);
    const showDesc = toolData.tooldesc && !isRedundantDesc(toolData.tooldesc, toolData.toolname);

    const baseApproval = userApprovalOverride || toolData.approval;
    const effectiveApproval = getEffectiveApprovalStatus(baseApproval, isStreaming);

    const isFileWriteTool = toolData.toolname === "write_text_file" || toolData.toolname === "edit_text_file";

    useEffect(() => {
        return () => {
            if (highlightTimeoutRef.current) {
                clearTimeout(highlightTimeoutRef.current);
            }
        };
    }, []);

    const handleApprove = () => {
        setUserApprovalOverride("user-approved");
        WaveAIModel.getInstance().toolUseSendApproval(toolData.toolcallid, "user-approved");
    };

    const handleDeny = () => {
        setUserApprovalOverride("user-denied");
        WaveAIModel.getInstance().toolUseSendApproval(toolData.toolcallid, "user-denied");
    };

    const handleMouseEnter = () => {
        if (!toolData.blockid) return;

        if (highlightTimeoutRef.current) {
            clearTimeout(highlightTimeoutRef.current);
        }

        highlightedBlockIdRef.current = toolData.blockid;
        BlockModel.getInstance().setBlockHighlight({
            blockId: toolData.blockid,
            icon: "sparkles",
        });

        highlightTimeoutRef.current = setTimeout(() => {
            if (highlightedBlockIdRef.current === toolData.blockid) {
                BlockModel.getInstance().setBlockHighlight(null);
                highlightedBlockIdRef.current = null;
            }
        }, 2000);
    };

    const handleMouseLeave = () => {
        if (!toolData.blockid) return;

        if (highlightTimeoutRef.current) {
            clearTimeout(highlightTimeoutRef.current);
            highlightTimeoutRef.current = null;
        }

        if (highlightedBlockIdRef.current === toolData.blockid) {
            BlockModel.getInstance().setBlockHighlight(null);
            highlightedBlockIdRef.current = null;
        }
    };

    const handleOpenDiff = () => {
        recordTEvent("waveai:showdiff");
        fireAndForget(() => WaveAIModel.getInstance().openDiff(toolData.inputfilename, toolData.toolcallid));
    };

    return (
        <div
            className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--surface-raised)] p-2 [box-shadow:inset_0_1px_0_var(--hair-top)]"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <div className="flex items-center gap-2">
                <StatusDot status={toolData.status} />
                <div className="min-w-0 truncate text-[13px] font-medium text-[var(--text)]">{toolLabel}</div>
                <div className="flex-1" />
                <span
                    className="hidden max-w-[45%] truncate font-mono text-[10px] text-[var(--text-dim)] @[260px]:inline"
                    title={toolData.toolname}
                >
                    {toolData.toolname}
                </span>
                {isFileWriteTool &&
                    toolData.inputfilename &&
                    toolData.writebackupfilename &&
                    toolData.runts &&
                    Date.now() - toolData.runts < BackupRetentionDays * 24 * 60 * 60 * 1000 && (
                        <button
                            onClick={() => {
                                recordTEvent("waveai:revertfile", { "waveai:action": "revertfile:open" });
                                model.openRestoreBackupModal(toolData.toolcallid);
                            }}
                            className="flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--hairline)] px-1.5 py-0.5 text-[var(--text-dim)] transition-colors hover:border-[var(--crowe-gold-40)] hover:bg-[var(--wash-accent-faint)] hover:text-[var(--accent)] cursor-pointer"
                            title="Restore backup file"
                        >
                            <span className="text-xs">Revert File</span>
                            <i className="fa fa-clock-rotate-left text-xs"></i>
                        </button>
                    )}
                {isFileWriteTool && toolData.inputfilename && (
                    <button
                        onClick={handleOpenDiff}
                        className="flex flex-shrink-0 items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--hairline)] px-1.5 py-0.5 text-[var(--text-dim)] transition-colors hover:border-[var(--crowe-gold-40)] hover:bg-[var(--wash-accent-faint)] hover:text-[var(--accent)] cursor-pointer"
                        title="Open in diff viewer"
                    >
                        <span className="text-xs">Show Diff</span>
                        <i className="fa fa-arrow-up-right-from-square text-xs"></i>
                    </button>
                )}
            </div>
            {showDesc && <ToolDesc text={toolData.tooldesc} className="pl-[14px] text-[13px] text-[var(--text-dim)]" />}
            {(toolData.errormessage || effectiveApproval === "timeout") && (
                <div className="pl-[14px] text-[12px] text-[var(--text-dim)]">
                    {toolData.errormessage || "Not approved"}
                </div>
            )}
            {effectiveApproval === "needs-approval" && (
                <div className="pl-[14px]">
                    <AIToolApprovalButtons count={1} onApprove={handleApprove} onDeny={handleDeny} />
                </div>
            )}
            {showRestoreModal && <RestoreBackupModal part={part} />}
        </div>
    );
});

AIToolUse.displayName = "AIToolUse";

interface AIToolProgressProps {
    part: WaveUIMessagePart & { type: "data-toolprogress" };
}

const AIToolProgress = memo(({ part }: AIToolProgressProps) => {
    const progressData = part.data;

    return (
        <div className="flex flex-col gap-1 p-2 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--surface-raised)] [box-shadow:inset_0_1px_0_var(--hair-top)]">
            <div className="flex items-center gap-2">
                <i className="fa fa-spinner fa-spin text-[var(--text-dim)]"></i>
                <div className="font-semibold">{progressData.toolname}</div>
            </div>
            {progressData.statuslines && progressData.statuslines.length > 0 && (
                <ToolDesc text={progressData.statuslines} className="text-sm text-[var(--text-dim)] pl-6 space-y-0.5" />
            )}
        </div>
    );
});

AIToolProgress.displayName = "AIToolProgress";

interface AIToolUseGroupProps {
    parts: Array<WaveUIMessagePart & { type: "data-tooluse" | "data-toolprogress" }>;
    isStreaming: boolean;
}

type ToolGroupItem =
    | { type: "batch"; parts: Array<WaveUIMessagePart & { type: "data-tooluse" }> }
    | { type: "single"; part: WaveUIMessagePart & { type: "data-tooluse" } }
    | { type: "progress"; part: WaveUIMessagePart & { type: "data-toolprogress" } };

export const AIToolUseGroup = memo(({ parts, isStreaming }: AIToolUseGroupProps) => {
    const tooluseParts = parts.filter((p) => p.type === "data-tooluse") as Array<
        WaveUIMessagePart & { type: "data-tooluse" }
    >;
    const toolprogressParts = parts.filter((p) => p.type === "data-toolprogress") as Array<
        WaveUIMessagePart & { type: "data-toolprogress" }
    >;

    const tooluseCallIds = new Set(tooluseParts.map((p) => p.data.toolcallid));
    const filteredProgressParts = toolprogressParts.filter((p) => !tooluseCallIds.has(p.data.toolcallid));

    const isFileOp = (part: WaveUIMessagePart & { type: "data-tooluse" }) => {
        const toolName = part.data?.toolname;
        return toolName === "read_text_file" || toolName === "read_dir";
    };

    const needsApproval = (part: WaveUIMessagePart & { type: "data-tooluse" }) => {
        return getEffectiveApprovalStatus(part.data?.approval, isStreaming) === "needs-approval";
    };

    const readFileNeedsApproval: Array<WaveUIMessagePart & { type: "data-tooluse" }> = [];
    const readFileOther: Array<WaveUIMessagePart & { type: "data-tooluse" }> = [];

    for (const part of tooluseParts) {
        if (isFileOp(part)) {
            if (needsApproval(part)) {
                readFileNeedsApproval.push(part);
            } else {
                readFileOther.push(part);
            }
        }
    }

    const groupedItems: ToolGroupItem[] = [];
    let addedApprovalBatch = false;
    let addedOtherBatch = false;

    for (const part of tooluseParts) {
        const isFileOpPart = isFileOp(part);
        const partNeedsApproval = needsApproval(part);

        if (isFileOpPart && partNeedsApproval) {
            if (!addedApprovalBatch) {
                groupedItems.push({ type: "batch", parts: readFileNeedsApproval });
                addedApprovalBatch = true;
            }
        } else if (isFileOpPart && !partNeedsApproval) {
            if (!addedOtherBatch) {
                groupedItems.push({ type: "batch", parts: readFileOther });
                addedOtherBatch = true;
            }
        } else {
            groupedItems.push({ type: "single", part });
        }
    }

    filteredProgressParts.forEach((part) => {
        groupedItems.push({ type: "progress", part });
    });

    return (
        <>
            {groupedItems.map((item, idx) => {
                if (item.type === "batch") {
                    return (
                        <div key={idx} className="mt-2">
                            <AIToolUseBatch parts={item.parts} isStreaming={isStreaming} />
                        </div>
                    );
                } else if (item.type === "progress") {
                    return (
                        <div key={idx} className="mt-2">
                            <AIToolProgress part={item.part} />
                        </div>
                    );
                } else {
                    return (
                        <div key={idx} className="mt-2">
                            <AIToolUse part={item.part} isStreaming={isStreaming} />
                        </div>
                    );
                }
            })}
        </>
    );
});

AIToolUseGroup.displayName = "AIToolUseGroup";
