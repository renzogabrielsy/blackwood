'use client'

import * as React from 'react'
import { ArrowUp, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface CaseChatInputProps {
  onSend: (text: string) => Promise<void> | void
  disabled?: boolean
  pending?: boolean
  placeholder?: string
}

const MAX_ROWS = 6
const LINE_HEIGHT_PX = 20

/**
 * Auto-grow chat composer for the case thread. Borrows the JarvisInput auto-grow
 * pattern (reset-to-auto, clamp to MAX_ROWS) without mounting the dormant Jarvis UI.
 * Enter sends; Shift+Enter newlines.
 */
export function CaseChatInput({ onSend, disabled, pending, placeholder }: CaseChatInputProps) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null)
  const [value, setValue] = React.useState('')

  const resize = React.useCallback(() => {
    const node = ref.current
    if (!node) return
    node.style.height = 'auto'
    const max = LINE_HEIGHT_PX * MAX_ROWS + 16
    node.style.height = `${Math.min(node.scrollHeight, max)}px`
  }, [])

  React.useEffect(() => {
    resize()
  }, [value, resize])

  const submit = React.useCallback(async () => {
    const text = value.trim()
    if (!text || disabled || pending) return
    setValue('')
    await onSend(text)
  }, [value, disabled, pending, onSend])

  const canSend = value.trim().length > 0 && !disabled && !pending

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className={cn(
        'flex items-end gap-2 rounded-md border border-border bg-card/80 px-2 py-2',
        'transition-shadow focus-within:ring-1 focus-within:ring-ring',
      )}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={
          pending ? 'Investigator is thinking…' : placeholder ?? 'Ask the investigator…'
        }
        disabled={disabled || pending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
        className={cn(
          'flex-1 resize-none bg-transparent text-sm leading-5 outline-none',
          'placeholder:text-muted-foreground/70 disabled:opacity-60',
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
