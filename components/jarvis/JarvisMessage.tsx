'use client'

import * as React from 'react'
import { ChevronRight, Cog, User, Sparkles } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'
import type { JarvisMessage as JarvisMessageType } from './useJarvisChat'

interface JarvisMessageProps {
    message: JarvisMessageType
}

function stringifyToolPayload(value: unknown): string {
    if (value === undefined) return 'undefined'
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function ToolCallStrip({
    name,
    args,
    result,
}: {
    name: string
    args: unknown
    result: unknown
}) {
    const summary =
        Array.isArray(result) && result.length > 0
            ? `${result.length} result${result.length === 1 ? '' : 's'}`
            : typeof result === 'object' && result !== null
                ? 'ok'
                : String(result ?? 'ok')

    return (
        <details className="group mt-1 rounded-md border border-border bg-muted/40 text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-muted-foreground hover:text-foreground">
                <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                <Cog className="h-3 w-3" />
                <span className="font-mono">{name}</span>
                <span className="ml-auto truncate text-[10px] opacity-70">{summary}</span>
            </summary>
            <div className="border-t border-border px-2 py-1.5 space-y-1.5">
                <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">args</div>
                    <pre className="mt-0.5 overflow-x-auto rounded bg-background/60 p-1.5 font-mono text-[11px] leading-snug">
                        {stringifyToolPayload(args)}
                    </pre>
                </div>
                <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">result</div>
                    <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-background/60 p-1.5 font-mono text-[11px] leading-snug">
                        {stringifyToolPayload(result)}
                    </pre>
                </div>
            </div>
        </details>
    )
}

/**
 * Markdown renderer for assistant turns. Supports GFM (tables, strikethrough),
 * scoped to look right inside the chat bubble — tight spacing, scrolling tables,
 * mono code blocks.
 */
function AssistantMarkdown({ content }: { content: string }) {
    return (
        <div className="prose-jarvis space-y-2 break-words">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    p: ({ children }) => <p className="leading-relaxed">{children}</p>,
                    ul: ({ children }) => (
                        <ul className="list-disc space-y-0.5 pl-4">{children}</ul>
                    ),
                    ol: ({ children }) => (
                        <ol className="list-decimal space-y-0.5 pl-4">{children}</ol>
                    ),
                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                    h1: ({ children }) => (
                        <h1 className="mt-2 text-base font-semibold">{children}</h1>
                    ),
                    h2: ({ children }) => (
                        <h2 className="mt-2 text-sm font-semibold">{children}</h2>
                    ),
                    h3: ({ children }) => (
                        <h3 className="mt-1 text-sm font-semibold">{children}</h3>
                    ),
                    a: ({ href, children }) => (
                        <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary underline underline-offset-2 hover:no-underline"
                        >
                            {children}
                        </a>
                    ),
                    blockquote: ({ children }) => (
                        <blockquote className="border-l-2 border-border pl-2 text-muted-foreground italic">
                            {children}
                        </blockquote>
                    ),
                    code: ({ className, children }) => {
                        const isBlock = /language-/.test(className ?? '')
                        if (isBlock) {
                            return (
                                <code className={cn('font-mono text-[12px]', className)}>
                                    {children}
                                </code>
                            )
                        }
                        return (
                            <code className="rounded bg-background/70 px-1 py-0.5 font-mono text-[12px]">
                                {children}
                            </code>
                        )
                    },
                    pre: ({ children }) => (
                        <pre className="my-1 overflow-x-auto rounded border border-border bg-background/60 p-2">
                            {children}
                        </pre>
                    ),
                    table: ({ children }) => (
                        <div className="my-1 overflow-x-auto rounded border border-border">
                            <table className="w-full border-collapse text-[12px]">{children}</table>
                        </div>
                    ),
                    thead: ({ children }) => (
                        <thead className="bg-background/60 text-left">{children}</thead>
                    ),
                    th: ({ children }) => (
                        <th className="border-b border-border px-2 py-1 font-semibold">{children}</th>
                    ),
                    td: ({ children }) => (
                        <td className="border-t border-border/60 px-2 py-1 font-mono">{children}</td>
                    ),
                    hr: () => <hr className="my-2 border-border" />,
                    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                    em: ({ children }) => <em className="italic">{children}</em>,
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    )
}

export function JarvisMessage({ message }: JarvisMessageProps) {
    if (message.role === 'system') {
        // System messages are infrastructure noise — render as a compact divider.
        return (
            <div className="px-4 py-1 text-center text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {message.content}
            </div>
        )
    }

    if (message.role === 'tool') {
        return (
            <div className="px-4">
                <ToolCallStrip
                    name="tool"
                    args={null}
                    result={message.content}
                />
            </div>
        )
    }

    const isUser = message.role === 'user'
    const Icon = isUser ? User : Sparkles

    return (
        <div
            className={cn(
                'flex w-full gap-2 px-4 animate-fade-in',
                isUser ? 'justify-end' : 'justify-start'
            )}
        >
            {!isUser && (
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                </div>
            )}
            <div
                className={cn(
                    'max-w-[85%] rounded-md px-3 py-2 text-sm leading-relaxed',
                    isUser
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-foreground border border-border'
                )}
            >
                {isUser ? (
                    <div className="whitespace-pre-wrap break-words">{message.content}</div>
                ) : (
                    <AssistantMarkdown content={message.content} />
                )}
                {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="mt-2 space-y-1">
                        {message.toolCalls.map((tc, i) => (
                            <ToolCallStrip
                                key={`${tc.name}-${i}`}
                                name={tc.name}
                                args={tc.args}
                                result={tc.result}
                            />
                        ))}
                    </div>
                )}
            </div>
            {isUser && (
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Icon className="h-3.5 w-3.5" />
                </div>
            )}
        </div>
    )
}

/**
 * Compact three-dot typing indicator for the in-flight assistant turn.
 */
export function JarvisTypingIndicator() {
    return (
        <div className="flex w-full gap-2 px-4 animate-fade-in">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" />
            </div>
            <div className="rounded-md border border-border bg-muted px-3 py-2">
                <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:300ms]" />
                </div>
            </div>
        </div>
    )
}
