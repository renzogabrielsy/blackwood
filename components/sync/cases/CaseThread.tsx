'use client'

import * as React from 'react'
import { ChevronRight, Cog, Search, User } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

/** A message row as it arrives from sync_case_messages (loose — Realtime rows). */
export interface ThreadMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  tool_calls: unknown
  tool_results: unknown
  position: number
}

function stringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

interface ToolCall {
  id?: string
  name?: string
  input?: unknown
}
interface ToolResult {
  tool_use_id?: string
  content?: string
}

/**
 * One collapsed "ran N checks" strip for an assistant turn's tool calls, paired
 * (best-effort) with the tool results from the following tool row. Borrows the
 * <details> pattern from JarvisMessage's ToolCallStrip.
 */
function ChecksStrip({ calls, results }: { calls: ToolCall[]; results: ToolResult[] }) {
  const n = calls.length
  if (n === 0) return null
  const resultById = new Map(results.map((r) => [r.tool_use_id, r.content]))

  return (
    <details className="group mt-1.5 rounded-md border border-border bg-muted/40 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
        <Search className="h-3 w-3" />
        <span>
          ran {n} check{n === 1 ? '' : 's'}
        </span>
        <span className="ml-auto truncate font-mono text-[10px] opacity-70">
          {calls.map((c) => c.name).filter(Boolean).join(', ')}
        </span>
      </summary>
      <div className="space-y-1.5 border-t border-border px-2 py-1.5">
        {calls.map((c, i) => (
          <div key={c.id ?? i} className="space-y-1">
            <div className="flex items-center gap-1.5 text-[11px]">
              <Cog className="h-3 w-3 text-muted-foreground" />
              <span className="font-mono font-medium">{c.name}</span>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">args</div>
              <pre className="mt-0.5 overflow-x-auto rounded bg-background/60 p-1.5 font-mono text-[11px] leading-snug">
                {stringify(c.input)}
              </pre>
            </div>
            {c.id && resultById.has(c.id) && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  result
                </div>
                <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-background/60 p-1.5 font-mono text-[11px] leading-snug">
                  {resultById.get(c.id)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

/** Markdown renderer for investigator turns — tight spacing, scrolling tables. */
function InvestigatorMarkdown({ content }: { content: string }) {
  return (
    <div className="space-y-2 break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-0.5 pl-4">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-0.5 pl-4">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? '')
            return isBlock ? (
              <code className={cn('font-mono text-[12px]', className)}>{children}</code>
            ) : (
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
          th: ({ children }) => (
            <th className="border-b border-border bg-background/60 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-t border-border/60 px-2 py-1 font-mono">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Render the case transcript. Tool rows are folded into the PRECEDING assistant
 * turn's checks strip, so the reader sees "the investigator said X, ran N checks"
 * rather than a bare tool payload. System rows become muted centered notices; user
 * rows become right-aligned bubbles.
 *
 * NB: the message list is NOT animated per-row (design rule — never animate rows /
 * long lists). Only the container fades in.
 */
export function CaseThread({ messages }: { messages: ThreadMessage[] }) {
  // Pair each assistant turn with the tool row immediately after it (its results).
  const items: React.ReactNode[] = []

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    if (m.role === 'tool') {
      // Rendered as part of the preceding assistant turn; skip standalone.
      continue
    }

    if (m.role === 'system') {
      items.push(
        <div
          key={m.id}
          className="px-2 py-1 text-center text-[10px] uppercase tracking-wide text-muted-foreground/70"
        >
          {m.content}
        </div>,
      )
      continue
    }

    const isUser = m.role === 'user'

    if (isUser) {
      items.push(
        <div key={m.id} className="flex w-full justify-end gap-2">
          <div className="max-w-[85%] rounded-md bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
            <div className="whitespace-pre-wrap break-words">{m.content}</div>
          </div>
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <User className="h-3.5 w-3.5" />
          </div>
        </div>,
      )
      continue
    }

    // assistant — pull this turn's tool calls + the next tool row's results.
    const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []) as ToolCall[]
    const next = messages[i + 1]
    const results = (next && next.role === 'tool' && Array.isArray(next.tool_results)
      ? next.tool_results
      : []) as ToolResult[]

    const hasText = m.content.trim().length > 0
    // An assistant turn that is ONLY a tool call (no text) still shows its strip.
    items.push(
      <div key={m.id} className="flex w-full justify-start gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
          <Search className="h-3.5 w-3.5" />
        </div>
        <div className="max-w-[85%] rounded-md border border-border bg-muted px-3 py-2 text-foreground">
          {hasText ? (
            <InvestigatorMarkdown content={m.content} />
          ) : (
            <p className="text-xs italic text-muted-foreground">Running checks…</p>
          )}
          <ChecksStrip calls={calls} results={results} />
        </div>
      </div>,
    )
  }

  return <div className="space-y-3">{items}</div>
}
