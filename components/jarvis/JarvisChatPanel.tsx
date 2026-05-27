'use client'

import * as React from 'react'
import { AlertCircle, Copy, Eraser, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'

import {
    Sheet,
    SheetClose,
    SheetContent,
    SheetDescription,
    SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useJarvis } from './JarvisProvider'
import { useJarvisChat } from './useJarvisChat'
import { JarvisMessage, JarvisTypingIndicator } from './JarvisMessage'
import { JarvisInput } from './JarvisInput'
import { JarvisConversationList } from './JarvisConversationList'

export function JarvisChatPanel() {
    const { open, setOpen } = useJarvis()
    const chat = useJarvisChat()
    const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const [confirmClear, setConfirmClear] = React.useState(false)

    // Auto-scroll the message list to the bottom whenever new content arrives
    // (new message or the typing indicator flips on).
    React.useEffect(() => {
        const node = scrollRef.current
        if (!node) return
        node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
    }, [chat.messages.length, chat.pending])

    // Focus the input shortly after the panel opens. We defer to next frame so
    // the Radix Dialog has placed the content in the DOM.
    React.useEffect(() => {
        if (!open) return
        const id = window.requestAnimationFrame(() => {
            inputRef.current?.focus()
        })
        return () => window.cancelAnimationFrame(id)
    }, [open])

    const handleClear = React.useCallback(async () => {
        if (!confirmClear) {
            setConfirmClear(true)
            window.setTimeout(() => setConfirmClear(false), 3000)
            return
        }
        setConfirmClear(false)
        await chat.clear()
    }, [chat, confirmClear])

    const empty = !chat.messagesLoading && chat.messages.length === 0 && !chat.pending

    return (
        <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
                side="right"
                showCloseButton={false}
                className={cn(
                    'p-0 sm:max-w-[480px] w-full',
                    'flex flex-col gap-0'
                )}
            >
                {/* Header */}
                <div className="flex-none border-b border-border bg-background/90 backdrop-blur-sm">
                    <div className="flex items-center justify-between px-4 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                                <Sparkles className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <SheetTitle className="text-sm font-semibold tracking-tight">
                                    Jarvis
                                </SheetTitle>
                                <SheetDescription className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                                    Sonnet 4.6
                                </SheetDescription>
                            </div>
                        </div>
                        <div className="flex items-center gap-1">
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={handleClear}
                                disabled={chat.pending}
                                title={confirmClear ? 'Click again to confirm' : 'Clear conversation (/clear)'}
                                className={cn(
                                    'text-muted-foreground hover:text-foreground',
                                    confirmClear && 'text-destructive hover:text-destructive'
                                )}
                            >
                                <Eraser className="h-4 w-4" />
                                <span className="sr-only">Clear conversation</span>
                            </Button>
                            <SheetClose asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="text-muted-foreground hover:text-foreground"
                                    aria-label="Close Jarvis"
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            </SheetClose>
                        </div>
                    </div>
                </div>

                {/* Conversation history (collapsible) */}
                <JarvisConversationList
                    conversations={chat.conversations}
                    activeId={chat.conversationId}
                    loading={chat.conversationsLoading}
                    onSelect={chat.switchConversation}
                    onNew={chat.startNewConversation}
                />

                {/* Message list */}
                <div
                    ref={scrollRef}
                    className="flex-1 min-h-0 overflow-y-auto py-3 space-y-2.5"
                >
                    {chat.messagesLoading ? (
                        <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent mr-2" />
                            Loading conversation…
                        </div>
                    ) : empty ? (
                        <div className="flex flex-col items-center justify-center px-6 py-12 text-center animate-fade-up">
                            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                                <Sparkles className="h-5 w-5" />
                            </div>
                            <p className="text-sm font-medium text-foreground">
                                Ask Jarvis anything about inventory.
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground max-w-[280px]">
                                Try: <span className="font-mono">&quot;What did we deliver yesterday?&quot;</span> or{' '}
                                <span className="font-mono">&quot;Closed batches this month&quot;</span>
                            </p>
                        </div>
                    ) : (
                        <>
                            {chat.messages.map((m) => (
                                <JarvisMessage key={m.id} message={m} />
                            ))}
                            {chat.pending && <JarvisTypingIndicator />}
                        </>
                    )}
                </div>

                {/* Inline error */}
                {chat.error && (
                    <div className="flex-none border-t border-destructive/30 bg-destructive/10 px-4 py-2">
                        <div className="flex items-start gap-2 text-xs text-destructive">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="font-medium">{chat.error}</p>
                                <div className="mt-0.5 flex items-center gap-3 text-[11px]">
                                    <button
                                        type="button"
                                        onClick={() => void chat.retryLast()}
                                        className="underline hover:no-underline disabled:opacity-50"
                                        disabled={chat.pending}
                                    >
                                        Retry last message
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (!chat.error) return
                                            void navigator.clipboard.writeText(chat.error).then(() => {
                                                toast.success('Error copied to clipboard', { duration: 2000 })
                                            })
                                        }}
                                        className="inline-flex items-center gap-1 underline hover:no-underline"
                                    >
                                        <Copy className="h-3 w-3" />
                                        Copy
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Input footer */}
                <div className="flex-none border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-3 py-2">
                    <JarvisInput
                        ref={inputRef}
                        onSend={chat.sendMessage}
                        pending={chat.pending}
                    />
                    <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-muted-foreground/70">
                        <span>
                            <kbd className="rounded border border-border bg-muted px-1 font-mono">Enter</kbd> send
                            <span className="mx-1.5">·</span>
                            <kbd className="rounded border border-border bg-muted px-1 font-mono">Shift+Enter</kbd> newline
                        </span>
                        <span>
                            <kbd className="rounded border border-border bg-muted px-1 font-mono">Cmd+K</kbd> toggle
                        </span>
                    </div>
                </div>
            </SheetContent>
        </Sheet>
    )
}
