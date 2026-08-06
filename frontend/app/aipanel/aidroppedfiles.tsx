// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { formatFileSize, getFileIcon } from "./ai-utils";
import type { WaveAIModel } from "./waveai-model";

interface AIDroppedFilesProps {
    model: WaveAIModel;
}

export const AIDroppedFiles = memo(({ model }: AIDroppedFilesProps) => {
    const droppedFiles = useAtomValue(model.droppedFiles);

    if (droppedFiles.length === 0) {
        return null;
    }

    return (
        <div className="border-b border-[var(--hairline-faint)] p-2">
            <div className="flex gap-2 overflow-x-auto pb-1">
                {droppedFiles.map((file) => (
                    <div
                        key={file.id}
                        className="group relative min-w-20 flex-shrink-0 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--surface-raised)] p-2 [box-shadow:inset_0_1px_0_var(--hair-top)]"
                    >
                        <button
                            onClick={() => model.removeFile(file.id)}
                            className="absolute right-1 top-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded-[var(--radius-xs)] bg-[var(--crowe-error)] text-[10px] text-[var(--accent-ink)] opacity-0 transition-opacity hover:brightness-110 group-hover:opacity-100"
                        >
                            <i className="fa fa-times text-xs"></i>
                        </button>

                        <div className="flex flex-col items-center text-center">
                            {file.previewUrl ? (
                                <div className="mb-1 h-12 w-12">
                                    <img
                                        src={file.previewUrl}
                                        alt={file.name}
                                        className="h-full w-full rounded-[var(--radius-xs)] object-cover"
                                    />
                                </div>
                            ) : (
                                <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-[var(--radius-xs)] bg-[var(--surface-sunken)]">
                                    <i
                                        className={cn(
                                            "fa text-lg text-[var(--text-dim)]",
                                            getFileIcon(file.name, file.type)
                                        )}
                                    ></i>
                                </div>
                            )}

                            <div className="w-full max-w-16 truncate text-[10px] text-[var(--text)]" title={file.name}>
                                {file.name}
                            </div>
                            <div className="text-[9px] text-[var(--text-dim)]">{formatFileSize(file.size)}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
});

AIDroppedFiles.displayName = "AIDroppedFiles";
