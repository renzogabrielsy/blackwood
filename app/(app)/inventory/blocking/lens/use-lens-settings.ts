'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PER-USER LENS SETTINGS — one document per lens, in `user_table_settings`.
//
// The data layer's own note (CONTEXT.md → "Price lens — DATA LAYER") ends with:
// *"Per-user lens CONFIG is the FRONTEND's job and needs NO migration … that
// column is a free-form `settings` jsonb with no per-key schema and no CHECK
// constraint, so an extra key needs no schema change. No table was added for it."*
// This hook is that job, and it adds no table, no column and no action.
//
// ── WHY NOT `useTableSettings()` ─────────────────────────────────────────────
// That provider is real and it does write `user_table_settings` — but it is mounted
// ONCE, globally, with `tableId = 'rc_in'`, and its document is typed
// `RcInTableSettings` (density, fontSize, hiddenColumns, labHighlights,
// columnWidths, columnFormats) with a setter per field and no arbitrary-key door.
// Storing a Blocking lens preference through it would mean filing it inside the RC
// IN table's row and widening the RC IN settings type to carry a Blocking concern —
// two wrongs to reach the same jsonb column. `getUserModuleSettings` /
// `saveUserModuleSettings` are the SHAPE-AGNOSTIC pair that already exist for
// exactly this (added for `/analytics`, R10 2026-09-03), and this hook is a
// narrower copy of `app/(app)/analytics/use-analytics-prefs.ts`'s disciplines.
//
// ── ONE MODULE ROW PER LENS, KEYED `blocking_lens_<id>` ──────────────────────
// `saveUserModuleSettings` REPLACES the whole document, so two lenses sharing one
// row would let each one's save erase the other's. A row per lens also means
// registering a second lens gets persistence for free, with no migration and no
// merge logic.
//
// ── FOUR DISCIPLINES, INHERITED RATHER THAN INVENTED ────────────────────────
// 1. Read in an EFFECT, never a lazy initialiser — the server renders the
//    defaults, so touching storage during render is a hydration mismatch.
// 2. Every read and write is wrapped. A private window, blocked site data or a
//    full quota all mean "this reader has no saved settings", which is the
//    default, which is a working panel. Never an error state.
// 3. The stored value is UNTRUSTED — `parse` is the caller's validator and it
//    runs on BOTH the local and the remote copy.
// 4. localStorage is written synchronously; the database on a 500 ms debounce.
//    A failure to reach the database is logged and dropped: a preference that did
//    not persist is still correct in this browser, and a toast for it would be
//    noise on a panel the reader opened to look at kilograms.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import {
  getUserModuleSettings,
  saveUserModuleSettings,
} from '@/lib/actions/table-settings';
import type { BlockingLensId } from './types';

/** `user_table_settings.module` for one lens. Also the localStorage key's base. */
export function lensSettingsModule(lensId: BlockingLensId): string {
  return `blocking_lens_${lensId}`;
}

export interface LensSettingsStore<S> {
  settings: S;
  /** Merge a change over the current document. */
  patch: (part: Partial<S>) => void;
  /** Everything back to the shipped defaults — here and in the database. */
  reset: () => void;
  /** True once storage has been consulted (so a panel can avoid a first-frame flash). */
  hydrated: boolean;
}

/**
 * Persist one lens's settings per user.
 *
 * `parse` (untrusted → valid) and `serialize` (valid → the smallest document that
 * reproduces it, defaults omitted) are supplied by the lens, so this hook never
 * needs to know a single field name.
 */
export function useLensSettings<S>(
  lensId: BlockingLensId,
  defaults: S,
  parse: (raw: unknown) => S,
  serialize: (value: S) => Record<string, unknown>,
): LensSettingsStore<S> {
  return useModuleSettings(lensSettingsModule(lensId), defaults, parse, serialize);
}

/**
 * The SAME storage, keyed by an arbitrary `user_table_settings.module`.
 *
 * `useLensSettings` is one caller of this (`blocking_lens_<id>`); the blend
 * proposal's Include-pages choice is the other (`blocking_blend_analysis`,
 * `_shared/blend-analysis-options.ts`). It is exported rather than copied because
 * the four disciplines in the header are the whole value of this file — a second
 * copy is how one of them quietly loses its `try` or its debounce, and a Blocking
 * preference that is not a LENS preference should not have to pretend to be one to
 * reuse them.
 */
export function useModuleSettings<S>(
  moduleKey: string,
  defaults: S,
  parse: (raw: unknown) => S,
  serialize: (value: S) => Record<string, unknown>,
): LensSettingsStore<S> {
  const storageKey = `bw.${moduleKey}.v1`;

  const [settings, setSettings] = React.useState<S>(defaults);
  const [hydrated, setHydrated] = React.useState(false);

  // The authoritative in-memory copy, so a patch never reads stale state and the
  // debounced save always sends the latest document.
  const currentRef = React.useRef<S>(defaults);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // `parse`, `serialize` and `defaults` are module-level constants at every call
  // site; capturing them once keeps them out of every callback's dependency list
  // (and keeps `reset` stable even if a caller passes a fresh object literal).
  const parseRef = React.useRef(parse);
  const serializeRef = React.useRef(serialize);
  const defaultsRef = React.useRef(defaults);

  const writeLocal = React.useCallback(
    (value: S) => {
      try {
        const body = serializeRef.current(value);
        if (Object.keys(body).length === 0) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, JSON.stringify(body));
      } catch {
        // Blocked store — the choice still holds for this session.
      }
    },
    [storageKey],
  );

  const scheduleRemoteSave = React.useCallback(
    (value: S) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const body = serializeRef.current(value);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void saveUserModuleSettings(moduleKey, body)
          .then((r) => {
            if (!r.success) console.error(`Failed to save ${moduleKey} settings:`, r.message);
          })
          .catch((e: unknown) => console.error(`Failed to save ${moduleKey} settings:`, e));
      }, 500);
    },
    [moduleKey],
  );

  const commit = React.useCallback(
    (value: S) => {
      currentRef.current = value;
      setSettings(value);
      writeLocal(value);
      scheduleRemoteSave(value);
    },
    [scheduleRemoteSave, writeLocal],
  );

  // ── Hydrate: local first (instant, and at least as fresh for this browser),
  //    then the per-user copy where this browser has nothing of its own. ──
  React.useEffect(() => {
    let cancelled = false;
    let hadLocal = false;

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw != null) {
        const local = parseRef.current(JSON.parse(raw));
        hadLocal = true;
        currentRef.current = local;
        setSettings(local);
      }
    } catch {
      // Unreadable or corrupt — the defaults are a complete answer.
    }
    setHydrated(true);

    void getUserModuleSettings(moduleKey)
      .then((remote) => {
        if (cancelled) return;
        if (remote == null) {
          // No row yet. If this browser carries something, seed the per-user copy
          // so a SECOND browser inherits it rather than starting over.
          if (hadLocal && Object.keys(serializeRef.current(currentRef.current)).length > 0) {
            scheduleRemoteSave(currentRef.current);
          }
          return;
        }
        if (hadLocal) return; // this browser's copy wins — it made the last change here
        const parsed = parseRef.current(remote);
        currentRef.current = parsed;
        setSettings(parsed);
        writeLocal(parsed);
      })
      .catch(() => {
        // Signed out, offline or unreadable. The local copy stands on its own.
      });

    return () => {
      cancelled = true;
    };
  }, [moduleKey, scheduleRemoteSave, storageKey, writeLocal]);

  React.useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const patch = React.useCallback(
    (part: Partial<S>) => commit({ ...currentRef.current, ...part }),
    [commit],
  );

  const reset = React.useCallback(() => commit(defaultsRef.current), [commit]);

  return { settings, patch, reset, hydrated };
}
