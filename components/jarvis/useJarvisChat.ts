'use client'

import * as React from 'react'
import {
    chat,
    clearConversation,
    getMessages,
    listConversations,
} from '@/app/(app)/jarvis/actions'

// ---------------------------------------------------------------------------
// Types — mirror the locked backend contract. Kept local so the UI can build
// against the contract even before the backend module lands at runtime.
// ---------------------------------------------------------------------------

export type JarvisRole = 'user' | 'assistant' | 'tool' | 'system'

export interface JarvisMessage {
    id: string
    role: JarvisRole
    content: string
    created_at: string
    // Tool calls executed alongside an assistant turn. Only present on the
    // assistant message that owns the tool batch — kept here so we can render
    // a collapsed strip inline without a second round-trip to the server.
    toolCalls?: Array<{
        name: string
        args: unknown
        result: unknown
    }>
}

export interface JarvisConversationSummary {
    id: string
    title: string
    created_at: string
    last_message_at: string
}

interface UseJarvisChatResult {
    conversationId: string | null
    conversations: JarvisConversationSummary[]
    messages: JarvisMessage[]
    pending: boolean
    error: string | null
    conversationsLoading: boolean
    messagesLoading: boolean
    // Actions
    sendMessage: (text: string) => Promise<void>
    switchConversation: (id: string) => Promise<void>
    startNewConversation: () => void
    clear: () => Promise<void>
    refreshConversations: () => Promise<JarvisConversationSummary[]>
    retryLast: () => Promise<void>
}

// Local-only id for optimistic appends (server returns ids on subsequent fetches)
function tempId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function readError(err: unknown): string {
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    return 'Jarvis is unreachable.'
}

export function useJarvisChat(): UseJarvisChatResult {
    const [conversationId, setConversationId] = React.useState<string | null>(null)
    const [conversations, setConversations] = React.useState<JarvisConversationSummary[]>([])
    const [messages, setMessages] = React.useState<JarvisMessage[]>([])
    const [pending, setPending] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [conversationsLoading, setConversationsLoading] = React.useState(false)
    const [messagesLoading, setMessagesLoading] = React.useState(false)
    const lastUserMessageRef = React.useRef<string | null>(null)

    const refreshConversations = React.useCallback(async () => {
        setConversationsLoading(true)
        try {
            const list = await listConversations()
            setConversations(list)
            return list
        } catch (err) {
            setError(readError(err))
            return [] as JarvisConversationSummary[]
        } finally {
            setConversationsLoading(false)
        }
    }, [])

    const loadMessages = React.useCallback(async (id: string) => {
        setMessagesLoading(true)
        try {
            const rows = await getMessages(id)
            setMessages(rows as JarvisMessage[])
        } catch (err) {
            setError(readError(err))
        } finally {
            setMessagesLoading(false)
        }
    }, [])

    // First-mount bootstrap: fetch the conversation list and select the most
    // recent one. If there are no conversations, leave conversationId null;
    // the first sendMessage will lazily create one via chat().
    const bootstrappedRef = React.useRef(false)
    const bootstrap = React.useCallback(async () => {
        if (bootstrappedRef.current) return
        bootstrappedRef.current = true
        const list = await refreshConversations()
        if (list.length > 0) {
            const mostRecent = list[0]
            setConversationId(mostRecent.id)
            await loadMessages(mostRecent.id)
        }
    }, [refreshConversations, loadMessages])

    // Bootstrap on first render — safe in StrictMode thanks to the ref guard.
    React.useEffect(() => {
        void bootstrap()
    }, [bootstrap])

    const switchConversation = React.useCallback(
        async (id: string) => {
            if (id === conversationId) return
            setConversationId(id)
            setError(null)
            await loadMessages(id)
        },
        [conversationId, loadMessages]
    )

    const startNewConversation = React.useCallback(() => {
        setConversationId(null)
        setMessages([])
        setError(null)
        lastUserMessageRef.current = null
    }, [])

    const sendMessage = React.useCallback(
        async (text: string) => {
            const trimmed = text.trim()
            if (!trimmed || pending) return

            lastUserMessageRef.current = trimmed
            setError(null)
            setPending(true)

            // Optimistic user bubble — replaced when the server response lands
            // (or just left in place; the server doesn't echo the user message).
            const userMsg: JarvisMessage = {
                id: tempId('u'),
                role: 'user',
                content: trimmed,
                created_at: new Date().toISOString(),
            }
            setMessages((prev) => [...prev, userMsg])

            try {
                const response = await chat({
                    conversationId,
                    message: trimmed,
                })
                const assistantMsg: JarvisMessage = {
                    id: tempId('a'),
                    role: 'assistant',
                    content: response.reply,
                    created_at: new Date().toISOString(),
                    toolCalls: response.toolCallsExecuted,
                }
                setMessages((prev) => [...prev, assistantMsg])

                if (response.conversationId !== conversationId) {
                    setConversationId(response.conversationId)
                    // Refresh the sidebar list so the new conversation appears
                    void refreshConversations()
                }
                lastUserMessageRef.current = null
            } catch (err) {
                setError(readError(err))
                // Leave the user message in place so retry has something to send.
            } finally {
                setPending(false)
            }
        },
        [conversationId, pending, refreshConversations]
    )

    const retryLast = React.useCallback(async () => {
        const last = lastUserMessageRef.current
        if (!last) return
        // Strip the previous failed-user-only bubble so it doesn't duplicate.
        setMessages((prev) => {
            const idx = [...prev].reverse().findIndex(
                (m) => m.role === 'user' && m.content === last
            )
            if (idx === -1) return prev
            const realIdx = prev.length - 1 - idx
            return prev.filter((_, i) => i !== realIdx)
        })
        await sendMessage(last)
    }, [sendMessage])

    const clear = React.useCallback(async () => {
        setPending(true)
        setError(null)
        try {
            const { conversationId: nextId } = await clearConversation()
            setConversationId(nextId ?? null)
            setMessages([])
            lastUserMessageRef.current = null
            void refreshConversations()
        } catch (err) {
            setError(readError(err))
        } finally {
            setPending(false)
        }
    }, [refreshConversations])

    return {
        conversationId,
        conversations,
        messages,
        pending,
        error,
        conversationsLoading,
        messagesLoading,
        sendMessage,
        switchConversation,
        startNewConversation,
        clear,
        refreshConversations,
        retryLast,
    }
}
