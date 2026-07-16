'use client'

import * as React from 'react'
import { ArrowUp, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface JarvisInputProps {
    onSend: (text: string) => Promise<void> | void
    disabled?: boolean
    pending?: boolean
    autoFocus?: boolean
}

const MAX_ROWS = 6
const LINE_HEIGHT_PX = 20 // matches `leading-5`

export const JarvisInput = React.forwardRef<HTMLTextAreaElement, JarvisInputProps>(
    function JarvisInput({ onSend, disabled, pending, autoFocus }, ref) {
        const localRef = React.useRef<HTMLTextAreaElement | null>(null)
        const [value, setValue] = React.useState('')

        const setRefs = React.useCallback(
            (node: HTMLTextAreaElement | null) => {
                localRef.current = node
                if (typeof ref === 'function') ref(node)
                else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node
            },
            [ref]
        )

        // Auto-grow: reset to the natural height, then clamp to MAX_ROWS lines.
        const resize = React.useCallback(() => {
            const node = localRef.current
            if (!node) return
            node.style.height = 'auto'
            const max = LINE_HEIGHT_PX * MAX_ROWS + 16 // + vertical padding
            node.style.height = `${Math.min(node.scrollHeight, max)}px`
        }, [])

        React.useEffect(() => {
            resize()
        }, [value, resize])

        React.useEffect(() => {
            if (autoFocus && localRef.current) {
                localRef.current.focus()
            }
        }, [autoFocus])

        const submit = React.useCallback(async () => {
            const text = value.trim()
            if (!text || disabled || pending) return
            setValue('')
            await onSend(text)
        }, [value, disabled, pending, onSend])

        const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
            }
        }

        const canSend = value.trim().length > 0 && !disabled && !pending

        return (
            <form
                onSubmit={(e) => {
                    e.preventDefault()
                    void submit()
                }}
                className={cn(
                    'flex items-end gap-2 rounded-md border border-border bg-card/80 px-2 py-2',
                    'focus-within:ring-1 focus-within:ring-ring transition-shadow'
                )}
            >
                <textarea
                    ref={setRefs}
                    rows={1}
                    value={value}
                    placeholder={pending ? 'Jarvis is thinking…' : 'Ask Jarvis…'}
                    disabled={disabled || pending}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className={cn(
                        'flex-1 resize-none bg-transparent text-sm leading-5 outline-none',
                        'placeholder:text-muted-foreground/70',
                        'disabled:opacity-60'
                    )}
                />
                <Button
                    type="submit"
                    size="icon-sm"
                    variant={canSend ? 'default' : 'ghost'}
                    disabled={!canSend}
                    className="shrink-0"
                    aria-label="Send message"
                >
                    {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                </Button>
            </form>
        )
    }
)
