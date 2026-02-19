/* ===================================================
   Dashboard Profile Store
   Pure utility module — no React, no Supabase.
   Manages multi-profile dashboard persistence in localStorage.

   Storage key: 'bw_v1' (replaces legacy 'bw_d6_prefs')
   =================================================== */

import type { D6Prefs } from './types'

/* ===================================================
   Storage shape
   =================================================== */

export interface DashboardProfile {
  id: string
  name: string
  createdAt: string
  prefs: D6Prefs
}

interface ProfileStore {
  activeProfileId: string
  profiles: DashboardProfile[]
}

const BW_V1_KEY = 'bw_v1'
const LEGACY_KEY = 'bw_d6_prefs'

/* ===================================================
   Internal read/write
   =================================================== */

function readStore(): ProfileStore | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(BW_V1_KEY)
    if (!raw) return null
    return JSON.parse(raw) as ProfileStore
  } catch {
    return null
  }
}

function writeStore(store: ProfileStore): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(BW_V1_KEY, JSON.stringify(store))
}

/* ===================================================
   Public API
   =================================================== */

/**
 * Load the profile store from localStorage.
 * Migrates from the legacy 'bw_d6_prefs' key on first load.
 * If neither key exists, creates a default profile using the provided defaultPrefs.
 */
export function loadProfileStore(defaultPrefs: D6Prefs): ProfileStore {
  if (typeof window === 'undefined') {
    return {
      activeProfileId: 'default',
      profiles: [{ id: 'default', name: 'Default', createdAt: new Date().toISOString(), prefs: defaultPrefs }],
    }
  }

  // 1. Try reading bw_v1
  const existing = readStore()
  if (existing && existing.profiles.length > 0) {
    // Self-heal: if activeProfileId is stale, reset to first profile
    if (!existing.profiles.find(p => p.id === existing.activeProfileId)) {
      existing.activeProfileId = existing.profiles[0].id
      writeStore(existing)
    }
    return existing
  }

  // 2. Check for legacy bw_d6_prefs
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const legacyPrefs = JSON.parse(legacyRaw) as D6Prefs
      const store: ProfileStore = {
        activeProfileId: 'default',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            createdAt: new Date().toISOString(),
            prefs: legacyPrefs,
          },
        ],
      }
      writeStore(store)
      localStorage.removeItem(LEGACY_KEY)
      return store
    }
  } catch {
    // Ignore legacy parse errors — fall through to create fresh store
  }

  // 3. Neither key found — create fresh default
  const store: ProfileStore = {
    activeProfileId: 'default',
    profiles: [
      {
        id: 'default',
        name: 'Default',
        createdAt: new Date().toISOString(),
        prefs: defaultPrefs,
      },
    ],
  }
  writeStore(store)
  return store
}

/** Persist the full profile store to localStorage */
export function saveProfileStore(store: ProfileStore): void {
  writeStore(store)
}

/** Return the active profile's prefs. Falls back to the first profile if active ID is invalid. */
export function getActiveProfile(defaultPrefs: D6Prefs): D6Prefs {
  const store = loadProfileStore(defaultPrefs)
  const active = store.profiles.find(p => p.id === store.activeProfileId)
  return active?.prefs ?? store.profiles[0]?.prefs ?? defaultPrefs
}

/** Update the active profile's prefs and persist */
export function updateActiveProfile(prefs: D6Prefs, defaultPrefs: D6Prefs): void {
  const store = loadProfileStore(defaultPrefs)
  let idx = store.profiles.findIndex(p => p.id === store.activeProfileId)
  if (idx === -1) {
    // activeProfileId is stale — self-heal by pointing to first profile
    idx = 0
    store.activeProfileId = store.profiles[0].id
  }
  store.profiles[idx] = { ...store.profiles[idx], prefs }
  writeStore(store)
}

/** List all profiles (id, name, createdAt — no prefs) */
export function listProfiles(defaultPrefs: D6Prefs): DashboardProfile[] {
  return loadProfileStore(defaultPrefs).profiles
}

/** Create a new profile, optionally cloning from existing prefs */
export function createProfile(name: string, defaultPrefs: D6Prefs, fromPrefs?: D6Prefs): DashboardProfile {
  const store = loadProfileStore(defaultPrefs)
  const id = `profile-${Date.now()}`
  const profile: DashboardProfile = {
    id,
    name,
    createdAt: new Date().toISOString(),
    prefs: fromPrefs ?? defaultPrefs,
  }
  store.profiles.push(profile)
  writeStore(store)
  return profile
}

/** Switch the active profile and return its prefs */
export function switchProfile(id: string, defaultPrefs: D6Prefs): D6Prefs {
  const store = loadProfileStore(defaultPrefs)
  const target = store.profiles.find(p => p.id === id)
  if (!target) throw new Error(`Profile '${id}' not found`)
  store.activeProfileId = id
  writeStore(store)
  return target.prefs
}

/** Delete a profile. Throws if it would be the last profile. */
export function deleteProfile(id: string, defaultPrefs: D6Prefs): void {
  const store = loadProfileStore(defaultPrefs)
  if (store.profiles.length <= 1) {
    throw new Error('Cannot delete the last profile')
  }
  store.profiles = store.profiles.filter(p => p.id !== id)
  // If we deleted the active profile, switch to the first remaining one
  if (store.activeProfileId === id) {
    store.activeProfileId = store.profiles[0].id
  }
  writeStore(store)
}

/** Get the active profile name without loading full prefs */
export function getActiveProfileName(defaultPrefs: D6Prefs): string {
  const store = loadProfileStore(defaultPrefs)
  return store.profiles.find(p => p.id === store.activeProfileId)?.name ?? 'Default'
}
