// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CopyButton } from "@/app/element/copybutton";
import { IconButton } from "@/app/element/iconbutton";
import { cn, useAtomValueSafe } from "@/util/util";
import type { Atom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bundledLanguages, codeToHtml } from "shiki/bundle/web";
import { Streamdown } from "streamdown";
import { throttle } from "throttle-debounce";

const ShikiTheme = "github-dark-high-contrast";

function extractText(node: React.ReactNode): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(extractText).join("");
    // @ts-expect-error props exists on ReactElement
    if (typeof node === "object" && node.props) return extractText(node.props.children);
    return "";
}

function CodePlain({ className = "", isCodeBlock, text }: { className?: string; isCodeBlock: boolean; text: string }) {
    if (isCodeBlock) {
        return <code className={cn("font-mono text-[12px]", className)}>{text}</code>;
    }

    return (
        <code
            className={cn(
                "rounded-[var(--radius-xs)] border border-[var(--hairline-faint)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[12.5px] text-[var(--crowe-gold-bright)]",
                className
            )}
        >
            {text}
        </code>
    );
}

function CodeHighlight({ className = "", lang, text }: { className?: string; lang: string; text: string }) {
    const [html, setHtml] = useState<string>("");
    const [hasError, setHasError] = useState(false);
    const codeRef = useRef<HTMLElement>(null);
    const seqRef = useRef(0);

    const highlightCode = useCallback(
        async (textToHighlight: string, language: string, disposedRef: { current: boolean }, seq: number) => {
            try {
                const full = await codeToHtml(textToHighlight, { lang: language, theme: ShikiTheme });
                const start = full.indexOf("<code");
                const open = full.indexOf(">", start);
                const end = full.lastIndexOf("</code>");
                const inner = start !== -1 && open !== -1 && end !== -1 ? full.slice(open + 1, end) : "";
                if (!disposedRef.current && seq === seqRef.current) {
                    setHtml(inner);
                    setHasError(false);
                }
            } catch (e) {
                if (!disposedRef.current && seq === seqRef.current) {
                    setHasError(true);
                }
                console.warn(`Shiki highlight failed for ${language}`, e);
            }
        },
        []
    );

    const throttledHighlight = useMemo(() => throttle(300, highlightCode, { noLeading: false }), [highlightCode]);

    useEffect(() => {
        const disposedRef = { current: false };

        if (!text) {
            setHtml("");
            return;
        }

        seqRef.current++;
        const currentSeq = seqRef.current;
        throttledHighlight(text, lang, disposedRef, currentSeq);

        return () => {
            disposedRef.current = true;
        };
    }, [text, lang, throttledHighlight]);

    if (hasError) {
        return (
            <code ref={codeRef} className={cn("font-mono text-[12px]", className)}>
                {text}
            </code>
        );
    }

    if (!html && text) {
        return (
            <code ref={codeRef} className={cn("font-mono text-[12px] text-transparent", className)}>
                {text}
            </code>
        );
    }

    return (
        <code
            ref={codeRef}
            className={cn("font-mono text-[12px]", className)}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

export function Code({ className = "", children }: { className?: string; children: React.ReactNode }) {
    const m = className?.match(/language-([\w+-]+)/i);
    const isCodeBlock = !!m;
    const lang = m?.[1] || "text";
    const text = extractText(children);

    if (isCodeBlock && lang in bundledLanguages) {
        return <CodeHighlight className={className} lang={lang} text={text} />;
    }

    return <CodePlain className={className} isCodeBlock={isCodeBlock} text={text} />;
}

type CodeBlockProps = {
    children: React.ReactNode;
    onClickExecute?: (cmd: string) => void;
    codeBlockMaxWidthAtom?: Atom<number>;
};

const CodeBlock = ({ children, onClickExecute, codeBlockMaxWidthAtom }: CodeBlockProps) => {
    const codeBlockMaxWidth = useAtomValueSafe(codeBlockMaxWidthAtom);
    const getLanguage = (children: any): string => {
        if (children?.props?.className) {
            const match = children.props.className.match(/language-([\w+-]+)/i);
            if (match) return match[1];
        }
        return "text";
    };

    const handleCopy = async (e: React.MouseEvent) => {
        const textToCopy = extractText(children).replace(/\n$/, "");
        await navigator.clipboard.writeText(textToCopy);
    };

    const handleExecute = (e: React.MouseEvent) => {
        const cmd = extractText(children).replace(/\n$/, "");
        if (onClickExecute) {
            onClickExecute(cmd);
            return;
        }
    };

    const language = getLanguage(children);

    return (
        <div
            className={cn(
                "my-4 overflow-hidden rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--surface-sunken)] [box-shadow:var(--shadow-card)]",
                codeBlockMaxWidth && "max-w-full"
            )}
            style={
                codeBlockMaxWidth
                    ? { maxWidth: codeBlockMaxWidth, minWidth: Math.min(400, codeBlockMaxWidth) }
                    : undefined
            }
        >
            <div className="flex items-center justify-between border-b border-[var(--hairline-faint)] bg-[var(--surface-raised)] pb-1.5 pl-3 pr-2 pt-2 [box-shadow:inset_0_1px_0_var(--hair-top)]">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--crowe-gold-65)]">
                    {language}
                </span>
                <div className="flex items-center gap-2">
                    <CopyButton onClick={handleCopy} title="Copy" />
                    {onClickExecute && (
                        <IconButton
                            decl={{
                                elemtype: "iconbutton",
                                icon: "regular@square-terminal",
                                click: handleExecute,
                            }}
                        />
                    )}
                </div>
            </div>
            <pre className="m-0 max-w-full overflow-x-auto px-4 pb-3 pt-2 text-secondary">{children}</pre>
        </div>
    );
};

function Collapsible({ title, children, defaultOpen = false }) {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    return (
        <div className="my-3">
            <button
                className="flex items-center gap-2 cursor-pointer bg-transparent border-0 p-0 font-medium text-secondary hover:text-primary"
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className="text-[0.65rem] text-primary transition-transform duration-200 inline-block w-3">
                    {isOpen ? "\u25BC" : "\u25B6"} {/* ▼ ▶ */}
                </span>
                <span>{title}</span>
            </button>
            {isOpen && <div className="mt-2 ml-1 pl-3.5 border-l-2 border-border text-secondary">{children}</div>}
        </div>
    );
}

interface WaveStreamdownProps {
    text: string;
    parseIncompleteMarkdown?: boolean;
    className?: string;
    onClickExecute?: (cmd: string) => void;
    codeBlockMaxWidthAtom?: Atom<number>;
}

export const WaveStreamdown = ({
    text,
    parseIncompleteMarkdown,
    className,
    onClickExecute,
    codeBlockMaxWidthAtom,
}: WaveStreamdownProps) => {
    const components = useMemo(
        () => ({
            code: Code,
            pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
                <CodeBlock
                    children={props.children}
                    onClickExecute={onClickExecute}
                    codeBlockMaxWidthAtom={codeBlockMaxWidthAtom}
                />
            ),
            p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
                <p {...props} className="text-[14px] leading-[1.6] text-[var(--text)]" />
            ),
            h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
                <h1
                    {...props}
                    className="mt-5 mb-2 font-serif text-[17px] font-medium leading-[1.2] tracking-[-0.01em] text-[var(--text)]"
                />
            ),
            h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
                <h2
                    {...props}
                    className="mt-4 mb-1.5 font-serif text-[15.5px] font-medium leading-[1.25] tracking-[-0.01em] text-[var(--text)]"
                />
            ),
            h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
                <h3
                    {...props}
                    className="mt-3 mb-1 font-serif text-[14px] font-medium leading-[1.3] text-[var(--text)]"
                />
            ),
            h4: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
                <h4
                    {...props}
                    className="mt-3 mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]"
                />
            ),
            h5: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
                <h5
                    {...props}
                    className="mt-2 mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]"
                />
            ),
            h6: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
                <h6
                    {...props}
                    className="mt-2 mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-dim)]"
                />
            ),
            table: (props: React.HTMLAttributes<HTMLTableElement>) => (
                <table {...props} className="my-3 w-full border-collapse text-[13px]" />
            ),
            thead: (props: React.HTMLAttributes<HTMLTableSectionElement>) => (
                <thead {...props} className="border-b border-[var(--hairline-strong)]" />
            ),
            tbody: (props: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />,
            tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => (
                <tr {...props} className="border-b border-[var(--hairline-faint)] last:border-0" />
            ),
            th: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
                <th
                    {...props}
                    className="px-2 py-1.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]"
                />
            ),
            td: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
                <td {...props} className="px-2 py-1.5 align-top text-[13px] tabular-nums text-[var(--text)]" />
            ),
            ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
                <ul
                    {...props}
                    className="mt-1 mb-2 list-outside list-disc pl-5 text-[var(--text)] marker:text-[var(--text-dim)] [&_ul]:my-1 [&_ol]:my-1"
                />
            ),
            ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
                <ol
                    {...props}
                    className="mt-1 mb-2 list-outside list-decimal pl-5 text-[var(--text)] marker:text-[var(--text-dim)] [&_ul]:my-1 [&_ol]:my-1"
                />
            ),
            li: (props: React.HTMLAttributes<HTMLLIElement>) => (
                <li {...props} className="mt-0.5 text-[14px] leading-[1.55] text-[var(--text)]" />
            ),
            blockquote: (props: React.HTMLAttributes<HTMLQuoteElement>) => (
                <blockquote
                    {...props}
                    className="my-2 border-l border-[var(--hairline-strong)] pl-3 text-[var(--text-dim)]"
                />
            ),
            details: ({ children, ...props }) => {
                const childArray = Array.isArray(children) ? children : [children];

                // Extract summary text and content
                const summary = childArray.find((c) => c?.props?.node?.tagName === "summary");
                const summaryText = summary?.props?.children || "Details";
                const content = childArray.filter((c) => c?.props?.node?.tagName !== "summary");

                return (
                    <Collapsible title={summaryText} defaultOpen={props.open}>
                        {content}
                    </Collapsible>
                );
            },
            summary: () => null, // Don't render summary separately
            a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
                <a {...props} className="text-accent hover:underline" />
            ),
            strong: (props: React.HTMLAttributes<HTMLElement>) => (
                <strong {...props} className="font-semibold text-[var(--text)]" />
            ),
            em: (props: React.HTMLAttributes<HTMLElement>) => <em {...props} className="italic text-secondary" />,
        }),
        [onClickExecute, codeBlockMaxWidthAtom]
    );

    return (
        <Streamdown
            parseIncompleteMarkdown={parseIncompleteMarkdown}
            className={cn(
                "wave-streamdown text-secondary [&>*:first-child]:mt-0 [&>*:first-child>*:first-child]:mt-0 space-y-2",
                className
            )}
            shikiTheme={[ShikiTheme, ShikiTheme]}
            controls={{
                code: false,
                table: false,
                mermaid: true,
            }}
            mermaid={{
                config: {
                    theme: "dark",
                    darkMode: true,
                },
            }}
            components={components}
        >
            {text}
        </Streamdown>
    );
};
