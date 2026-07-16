'use client'

import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { MessageSquarePlus, History, ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { JarvisConversationSummary } from './useJarvisChat'

interface JarvisConversationListProps {
    conversations: JarvisConversationSummary[]
    activeId: string | null
    loading: boolean
    onSelect: (id: string) => void
    onNew: () => void
}

function relative(ts: string): string {
    try {
        return formatDistanceToNow(new Date(ts), { addSuffix: false })
            .replace('about ', '')
            .replace('less than a minute', '<1m')
            .replace(' minutes', 'm')
            .replace(' minute', 'm')
            .replace(' hours', 'h')
            .replace(' hour', 'h')
            .replace(' days', 'd')
            .replace(' day', 'd')
    } catch {
        return ''
    }
}

export function JarvisConversationList({
    conversations,
    activeId,
    loading,
    onSelect,
    onNew,
}: JarvisConversationListProps) {
    const [expanded, setExpanded] = React.useState(false)

    const recent = conversations.slice(0, expanded ? conversations.length : 5)

    return (
        <div className="border-b border-border bg-background/60">
            <div className="flex items-center justify-between px-4 py-1.5">
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
                >
                    <History className="h-3 w-3" />
                    <span>History</span>
                    <span className="font-mono opacity-60">({conversations.length})</span>
                    <ChevronDown
                        className={cn(
                            'h-3 w-3 transition-transform duration-150',
                            expanded && 'rotate-180'
                        )}
                    />
                </button>
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={onNew}
                    className="gap-1 text-[11px]"
                >
                    <MessageSquarePlus className="h-3 w-3" />
                    New
                </Button>
            </div>

            {expanded && (
                <div className="max-h-48 overflow-y-auto px-2 pb-2">
                    {loading ? (
                        <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                            Loading…
                        </div>
                    ) : recent.length === 0 ? (
                        <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                            No past conversations.
                        </div>
                    ) : (
                        <ul className="space-y-0.5">
                            {recent.map((c) => {
                                const isActive = c.id === activeId
                                return (
                                    <li key={c.id}>
                                        <button
                                            type="button"
                                            onClick={() => onSelect(c.id)}
                                            className={cn(
                                                'flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-xs transition-colors',
                                                isActive
                                                    ? 'bg-accent text-accent-foreground'
                                                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                                            )}
                                        >
                                            <span className="truncate">{c.title || 'Untitled'}</span>
                                            <span className="ml-2 shrink-0 font-mono text-[10px] opacity-70">
                                                {relative(c.last_message_at || c.created_at)}
                                            </span>
                                        </button>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}
