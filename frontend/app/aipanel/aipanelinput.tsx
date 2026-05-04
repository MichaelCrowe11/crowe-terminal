// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { formatFileSizeError, isAcceptableFile, validateFileSize } from "@/app/aipanel/ai-utils";
import { waveAIHasFocusWithin } from "@/app/aipanel/waveai-focus-utils";
import { type WaveAIModel } from "@/app/aipanel/waveai-model";
import { Tooltip } from "@/element/tooltip";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef } from "react";

interface AIPanelInputProps {
    onSubmit: (e: React.FormEvent) => void;
    status: string;
    model: WaveAIModel;
}

export interface AIPanelInputRef {
    focus: () => void;
    resize: () => void;
    scrollToBottom: () => void;
    selectRange: (start: number, end: number) => void;
}

export const AIPanelInput = memo(({ onSubmit, status, model }: AIPanelInputProps) => {
    const [input, setInput] = useAtom(model.inputAtom);
    const isFocused = useAtomValue(model.isWaveAIFocusedAtom);
    const isChatEmpty = useAtomValue(model.isChatEmptyAtom);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isPanelOpen = useAtomValue(model.getPanelVisibleAtom());

    let placeholder: string;
    if (!isChatEmpty) {
        placeholder = "Continue...";
    } else if (model.inBuilder) {
        placeholder = "What would you like to build...";
    } else {
        placeholder = "Ask Crowe Logic anything...";
    }

    const resizeTextarea = useCallback(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        textarea.style.height = "auto";
        const scrollHeight = textarea.scrollHeight;
        const maxHeight = 7 * 24;
        textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
    }, []);

    useEffect(() => {
        const inputRefObject: React.RefObject<AIPanelInputRef> = {
            current: {
                focus: () => {
                    textareaRef.current?.focus();
                },
                resize: resizeTextarea,
                scrollToBottom: () => {
                    const textarea = textareaRef.current;
                    if (textarea) {
                        textarea.scrollTop = textarea.scrollHeight;
                    }
                },
                selectRange: (start: number, end: number) => {
                    const textarea = textareaRef.current;
                    if (!textarea) return;
                    textarea.focus();
                    textarea.setSelectionRange(start, end);
                },
            },
        };
        model.registerInputRef(inputRefObject);
    }, [model, resizeTextarea]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const isComposing = e.nativeEvent?.isComposing || e.keyCode == 229;
        if (e.key === "Enter" && !e.shiftKey && !isComposing) {
            e.preventDefault();
            onSubmit(e as any);
        }
    };

    const handleFocus = useCallback(() => {
        model.requestWaveAIFocus();
    }, [model]);

    const handleBlur = useCallback(
        (e: React.FocusEvent) => {
            if (e.relatedTarget === null) {
                return;
            }

            if (waveAIHasFocusWithin(e.relatedTarget)) {
                return;
            }

            model.requestNodeFocus();
        },
        [model]
    );

    useEffect(() => {
        resizeTextarea();
    }, [input, resizeTextarea]);

    useEffect(() => {
        if (isPanelOpen) {
            resizeTextarea();
        }
    }, [isPanelOpen, resizeTextarea]);

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        const acceptableFiles = files.filter(isAcceptableFile);

        for (const file of acceptableFiles) {
            const sizeError = validateFileSize(file);
            if (sizeError) {
                model.setError(formatFileSizeError(sizeError));
                if (e.target) {
                    e.target.value = "";
                }
                return;
            }
            await model.addFile(file);
        }

        if (acceptableFiles.length < files.length) {
            console.warn(`${files.length - acceptableFiles.length} files were rejected due to unsupported file types`);
        }

        if (e.target) {
            e.target.value = "";
        }
    };

    return (
        <div
            className={cn(
                "border-t bg-[#0b0b0c]/40 transition-colors",
                isFocused ? "border-[#bfa669]/40" : "border-[#bfa669]/15"
            )}
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.js,.jsx,.ts,.tsx,.go,.py,.java,.c,.cpp,.h,.hpp,.html,.css,.scss,.sass,.json,.xml,.yaml,.yml,.sh,.bat,.sql"
                onChange={handleFileChange}
                className="hidden"
            />
            <form onSubmit={onSubmit}>
                <div className="relative pl-3">
                    <span
                        aria-hidden="true"
                        className={cn(
                            "absolute left-2 top-2 font-mono text-[13px] select-none transition-colors",
                            isFocused ? "text-[#bfa669]" : "text-[#bfa669]/50"
                        )}
                    >
                        $
                    </span>
                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={handleFocus}
                        onBlur={handleBlur}
                        placeholder={placeholder}
                        className={cn(
                            "w-full text-foreground/95 placeholder-zinc-500 pl-4 pr-12 py-2 focus:outline-none resize-none overflow-auto bg-transparent"
                        )}
                        style={{ fontSize: "13px" }}
                        rows={2}
                    />
                    <Tooltip content="Attach files" placement="top" divClassName="absolute bottom-6.5 right-1.5">
                        <button
                            type="button"
                            onClick={handleUploadClick}
                            className={cn(
                                "w-6 h-6 rounded transition-colors flex items-center justify-center text-zinc-500 hover:text-[#bfa669] cursor-pointer"
                            )}
                        >
                            <i className="fa fa-paperclip text-[12px]"></i>
                        </button>
                    </Tooltip>
                    {status === "streaming" ? (
                        <Tooltip content="Stop Response" placement="top" divClassName="absolute bottom-1.5 right-1.5">
                            <button
                                type="button"
                                onClick={() => model.stopResponse()}
                                className={cn(
                                    "w-6 h-6 rounded transition-colors flex items-center justify-center cursor-pointer",
                                    "text-red-400 hover:text-red-300 hover:bg-red-500/10"
                                )}
                            >
                                <i className="fa fa-square text-[12px]"></i>
                            </button>
                        </Tooltip>
                    ) : (
                        <Tooltip content="Send (Enter)" placement="top" divClassName="absolute bottom-1.5 right-1.5">
                            <button
                                type="submit"
                                disabled={status !== "ready" || !input.trim()}
                                className={cn(
                                    "w-6 h-6 rounded transition-colors flex items-center justify-center",
                                    status !== "ready" || !input.trim()
                                        ? "text-zinc-600 cursor-default"
                                        : "text-[#bfa669] hover:text-[#bfa669] hover:bg-[#bfa669]/10 cursor-pointer"
                                )}
                            >
                                <i className="fa fa-arrow-up text-[12px]"></i>
                            </button>
                        </Tooltip>
                    )}
                </div>
            </form>
        </div>
    );
});

AIPanelInput.displayName = "AIPanelInput";
