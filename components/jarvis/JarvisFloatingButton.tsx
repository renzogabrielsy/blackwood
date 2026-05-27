'use client'

import * as React from 'react'
import { Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useJarvis } from './JarvisProvider'

const FIRST_MOUNT_KEY = 'bw_jarvis_seen'

/**
 * Fixed-position FAB at the bottom-right of the viewport. Toggles the chat
 * panel; hides itself while the panel is open so it doesn't overlap.
 *
 * On the user's very first visit (no localStorage marker), the button gets a
 * subtle fade-up entrance to draw the eye. After that, mounts are silent.
 */
export function JarvisFloatingButton() {
    const { open, toggle } = useJarvis()
    const [isFirstMount, setIsFirstMount] = React.useState(false)

    React.useEffect(() => {
        try {
            const seen = window.localStorage.getItem(FIRST_MOUNT_KEY)
            if (!seen) {
                setIsFirstMount(true)
                window.localStorage.setItem(FIRST_MOUNT_KEY, '1')
            }
        } catch {
            // localStorage may be blocked — skip entrance animation, no big deal
        }
    }, [])

    if (open) return null

    return (
        <button
            type="button"
            onClick={toggle}
            aria-label="Open Jarvis"
            title="Jarvis (Cmd+K)"
            className={cn(
                'fixed bottom-4 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full',
                'border border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60',
                'shadow-lg text-foreground/80 hover:text-foreground hover:bg-background/90',
                'transition-[transform,background-color,color] duration-150 hover:scale-[1.04] active:scale-[0.97]',
                isFirstMount && 'animate-fade-up'
            )}
        >
            <Sparkles className="h-5 w-5" />
        </button>
    )
}
