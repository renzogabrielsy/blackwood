'use client'

import * as React from 'react'

/**
 * SSR-safe media-query subscription. Returns whether `query` currently matches.
 *
 * Built on `useSyncExternalStore` so the server snapshot is deterministic
 * (`false`) and the client resolves the real value on mount — no hydration
 * mismatch. Use for cases where a pure CSS `sm:hidden`/`hidden sm:block` split
 * cannot work, e.g. picking between two PORTALED surfaces (a Dialog vs a Sheet)
 * where a wrapper class can't hide the portaled content and mounting both would
 * double the overlay + focus trap.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )

  const getSnapshot = React.useCallback(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  }, [query])

  // Server snapshot is always `false` — the client resolves the real value on mount.
  const getServerSnapshot = React.useCallback(() => false, [])

  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
