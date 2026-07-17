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
    const widgetAccess = useAtomValue(model.widgetAccessAtom);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isPanelOpen = useAtomValue(model.getPanelVisibleAtom());

    let placeholder: string;
    if (!isChatEmpty) {
        placeholder = "Continue...";
    } else if (model.inBuilder) {
        placeholder = "What would you like to build...";
    } else {
        placeholder = "Ask Hypheus anything...";
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

    const canSend = status === "ready" && !!input.trim();

    return (
        <div className="border-t border-[var(--hairline-faint)] bg-[var(--glass-tint-chrome)] px-2.5 pb-2.5 pt-2 backdrop-blur-2xl [box-shadow:inset_0_1px_0_var(--hair-top)]">
            <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.js,.jsx,.ts,.tsx,.go,.py,.java,.c,.cpp,.h,.hpp,.html,.css,.scss,.sass,.json,.xml,.yaml,.yml,.sh,.bat,.sql"
                onChange={handleFileChange}
                className="hidden"
            />
            <form onSubmit={onSubmit}>
                <div
                    className={cn(
                        "rounded-[var(--radius-md)] border bg-[var(--surface-sunken)] transition-all duration-150",
                        isFocused
                            ? "border-[var(--crowe-gold-45)] shadow-[0_0_0_3px_var(--crowe-gold-12)]"
                            : "border-[var(--hairline)] hover:border-[var(--hairline-strong)]"
                    )}
                >
                    <div className="relative">
                        <span
                            aria-hidden="true"
                            title={widgetAccess ? "tools on" : "tools off (sandboxed)"}
                            className={cn(
                                "absolute left-2.5 top-2 select-none font-mono text-[13px] transition-colors",
                                !widgetAccess
                                    ? "text-[var(--text-dim)]"
                                    : isFocused
                                      ? "text-[var(--accent)]"
                                      : "text-[var(--crowe-gold-50)]"
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
                            className="w-full resize-none overflow-auto bg-transparent py-2 pl-6 pr-3 text-[var(--text)] placeholder-[var(--crowe-parchment-40)] focus:outline-none"
                            style={{ fontSize: "13px" }}
                            rows={2}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
                        <Tooltip content="Attach files" placement="top">
                            <button
                                type="button"
                                onClick={handleUploadClick}
                                aria-label="Attach files"
                                className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-dim)] transition-colors hover:bg-[var(--wash-accent-faint)] hover:text-[var(--accent)] cursor-pointer"
                            >
                                <i className="fa fa-paperclip text-[12px]"></i>
                            </button>
                        </Tooltip>
                        <div className="flex items-center gap-2">
                            <span className="hidden select-none font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--crowe-parchment-40)] @[300px]:inline">
                                {status === "streaming" ? "streaming" : "enter to send"}
                            </span>
                            {status === "streaming" ? (
                                <Tooltip content="Stop response" placement="top">
                                    <button
                                        type="button"
                                        onClick={() => model.stopResponse()}
                                        aria-label="Stop response"
                                        className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--crowe-error-15)] text-[var(--crowe-error)] transition-all hover:brightness-110 cursor-pointer"
                                    >
                                        <i className="fa fa-stop text-[11px]"></i>
                                    </button>
                                </Tooltip>
                            ) : (
                                <Tooltip content="Send (Enter)" placement="top">
                                    <button
                                        type="submit"
                                        disabled={!canSend}
                                        aria-label="Send"
                                        className={cn(
                                            "flex h-7 w-7 items-center justify-center rounded-full transition-all duration-150",
                                            canSend
                                                ? "bg-[var(--accent)] text-[var(--accent-ink)] shadow-[0_0_10px_-2px_var(--glow-gold)] hover:brightness-110 cursor-pointer"
                                                : "bg-[var(--wash-accent-faint)] text-[var(--crowe-parchment-40)] cursor-default"
                                        )}
                                    >
                                        <i className="fa fa-arrow-up text-[11px]"></i>
                                    </button>
                                </Tooltip>
                            )}
                        </div>
                    </div>
                </div>
            </form>
        </div>
    );
});

AIPanelInput.displayName = "AIPanelInput";
