'use client'

import * as React from 'react'

const STORAGE_KEY = 'bw_jarvis_open'

interface JarvisContextValue {
    open: boolean
    setOpen: (next: boolean) => void
    toggle: () => void
}

const JarvisContext = React.createContext<JarvisContextValue | null>(null)

export function useJarvis(): JarvisContextValue {
    const ctx = React.useContext(JarvisContext)
    if (!ctx) {
        throw new Error('useJarvis must be used inside a <JarvisProvider />')
    }
    return ctx
}

export function JarvisProvider({ children }: { children: React.ReactNode }) {
    // Start closed on first render to avoid hydration mismatch — hydrate
    // from localStorage in an effect.
    const [open, setOpenState] = React.useState<boolean>(false)

    React.useEffect(() => {
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY)
            if (stored === '1') setOpenState(true)
        } catch {
            // localStorage may throw in privacy mode — fail silent
        }
    }, [])

    const setOpen = React.useCallback((next: boolean) => {
        setOpenState(next)
        try {
            window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
        } catch {
            // ignore
        }
    }, [])

    const toggle = React.useCallback(() => {
        setOpenState((prev) => {
            const next = !prev
            try {
                window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
            } catch {
                // ignore
            }
            return next
        })
    }, [])

    // Global Cmd/Ctrl+K toggles the panel. Ignores when focus is inside
    // contentEditable, but textareas/inputs are fine — Cmd+K is uncommon there.
    React.useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            const isMod = event.metaKey || event.ctrlKey
            if (!isMod || event.key.toLowerCase() !== 'k') return
            const target = event.target as HTMLElement | null
            if (target?.isContentEditable) return
            event.preventDefault()
            toggle()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [toggle])

    const value = React.useMemo<JarvisContextValue>(
        () => ({ open, setOpen, toggle }),
        [open, setOpen, toggle]
    )

    return (
        <JarvisContext.Provider value={value}>{children}</JarvisContext.Provider>
    )
}
