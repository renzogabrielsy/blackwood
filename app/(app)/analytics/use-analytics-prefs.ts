"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE READER'S OWN ANALYTICS SETTINGS — one store, per user (R10, 2026-09-03)
//
// Renzo, verbatim: *"Currently, the style selections for the charts in analytics
// has no sense of memory or permanence when it comes to user selection. Every
// choice is made back to default when switching around different charts and
// rows and from a refresh. I would much rather it remembers the last settings
// used per user."*
//
// ── WHY ONE STORE AND NOT SIX HOOKS ─────────────────────────────────────────
// Before this round the page had THREE places a preference could live —
// `use-year-styles.ts` (localStorage), `use-row-order.ts` (localStorage) and a
// scatter of `React.useState` inside `metric-expand.tsx` and
// `analytics-view.tsx`. The useState ones are exactly the ones that "reset when
// switching around different charts and rows": both call sites `key` the expand
// card by metric, so opening another row REMOUNTS it and its state starts over.
// Moving them into one record is what makes them survive a row change, a
// section change and a reload, and doing it in ONE record is what makes a
// single Reset possible and a single debounce enough.
//
// ── DUAL PERSISTENCE, COPIED FROM `components/providers/table-settings.tsx` ──
//   • `localStorage` under `bw.analytics.prefs.v1`, written SYNCHRONOUSLY on
//     every change — instant, survives a reload, works offline;
//   • `user_table_settings (user_id, module='analytics', settings jsonb)`,
//     written on a 500 ms debounce — this is the PER USER half, the thing that
//     follows the reader to another browser. Last write wins.
//
// ── FOUR DISCIPLINES, ALL INHERITED RATHER THAN INVENTED ────────────────────
// 1. **Read in an EFFECT, never a lazy initialiser.** The server renders the
//    defaults, so touching storage during render is a hydration mismatch. The
//    saved record lands on the tick after mount. (`use-row-order.ts`'s property
//    1, and the reason `table-settings.tsx`'s lazy initialiser is NOT copied.)
// 2. **Every read and write is wrapped.** A private window, blocked site data
//    or a full quota all mean "this reader has no saved settings" — which is
//    the default, which is a working page. Never an error state.
// 3. **The stored value is UNTRUSTED.** `parseAnalyticsPrefs` validates every
//    field and drops anything it did not write, because a colour goes straight
//    into a `style` attribute.
// 4. **Same-tab broadcast.** The browser's own `storage` event fires in OTHER
//    tabs only, and this page mounts several readers of this store at once (two
//    expands can be open, plus the matrix and the shell). A module-level
//    subscriber set is what keeps them live with each other — carried forward
//    verbatim from `use-year-styles.ts`, whose store this replaces.
//
// ── WHAT IS **NOT** IN HERE, AND WHY ────────────────────────────────────────
// `?year=`, `?hide=`, `?bhide=` and `?metric=` stay in the URL and only in the
// URL. A URL is a shareable STATEMENT about what is on screen; a preference is
// a habit. Storing a shared window would mean two people opening the same link
// see different figures, which is the one thing the address bar exists to
// prevent. The three toggles that ARE stored (`wd`, `cmp`, `dict`) are still
// written to the URL exactly as before — the preference only answers the
// question an address left silent.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  ANALYTICS_PREFS_KEY,
  ANALYTICS_PREFS_MODULE,
  DEFAULT_ANALYTICS_PREFS,
  chooseStoredPrefs,
  isDefaultPrefs,
  migrateLegacyPrefs,
  parseAnalyticsPrefs,
  pruneAnalyticsPrefs,
  serializeAnalyticsPrefs,
  type AnalyticsPrefs,
} from "@/lib/analytics/prefs";
import {
  getUserModuleSettings,
  saveUserModuleSettings,
} from "@/lib/actions/table-settings";

// ── The module-level store ───────────────────────────────────────────────────
// Not React context: the readers are mounted by components with no common
// provider (the matrix, the shell, and two expand cards rendered from different
// rooms), and threading a provider through the page for a preference would be
// more machinery than the preference. The same judgement `use-year-styles.ts`
// already made and this store inherits.

let current: AnalyticsPrefs = { ...DEFAULT_ANALYTICS_PREFS };
/** Has the effect below read storage yet? Guards the one-time hydrate. */
let hydrated = false;
/** Has the remote copy been asked for yet? One request per page load. */
let remoteRequested = false;

type Listener = (next: AnalyticsPrefs) => void;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(current);
}

function readLocal(): AnalyticsPrefs | null {
  try {
    const raw = window.localStorage.getItem(ANALYTICS_PREFS_KEY);
    if (raw == null) return null;
    return parseAnalyticsPrefs(raw);
  } catch {
    return null;
  }
}

/** Every `localStorage` pair, for the one-time legacy fold. Never throws. */
function readAllEntries(): (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key == null) continue;
      const value = window.localStorage.getItem(key);
      if (value == null) continue;
      out.push([key, value] as const);
    }
  } catch {
    return [];
  }
  return out;
}

function writeLocal(next: AnalyticsPrefs) {
  try {
    const body = serializeAnalyticsPrefs(next);
    if (Object.keys(body).length === 0) {
      window.localStorage.removeItem(ANALYTICS_PREFS_KEY);
    } else {
      window.localStorage.setItem(ANALYTICS_PREFS_KEY, JSON.stringify(body));
    }
  } catch {
    // A blocked store is not an error the reader can act on. The session keeps
    // the choice in memory; it simply will not survive a reload.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The 500 ms debounce onto `user_table_settings`, exactly as the table-settings
 * provider does it. A failure is logged and dropped: a preference that did not
 * reach the database is still correct in this browser, and a toast for it would
 * be noise on a page whose whole job is to be read.
 */
function scheduleRemoteSave(next: AnalyticsPrefs) {
  if (saveTimer) clearTimeout(saveTimer);
  const body = serializeAnalyticsPrefs(next);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveUserModuleSettings(ANALYTICS_PREFS_MODULE, body).then((r) => {
      if (!r.success) {
        console.error("Failed to save analytics preferences:", r.message);
      }
    }).catch((e: unknown) => {
      console.error("Failed to save analytics preferences:", e);
    });
  }, 500);
}

/** Publish a new record everywhere: memory → subscribers → local → remote. */
function commit(next: AnalyticsPrefs) {
  current = next;
  emit();
  writeLocal(next);
  scheduleRemoteSave(next);
}

/**
 * Adopt a record that came FROM storage — so it is published and cached, but
 * never written straight back to the database it just came from.
 */
function adopt(next: AnalyticsPrefs, { cacheLocally }: { cacheLocally: boolean }) {
  current = next;
  emit();
  if (cacheLocally) writeLocal(next);
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;

  const local = readLocal();
  if (local) {
    adopt(local, { cacheLocally: false });
  } else {
    // ── THE ONE-TIME LEGACY FOLD ───────────────────────────────────────────
    // A reader who set year colours in R9 or dragged rows in R5 keeps both.
    // It runs only when no R10 record exists, so it can never overwrite a
    // later choice, and the old keys are left in place rather than deleted —
    // a rollback to the previous build must still find them.
    const migrated = migrateLegacyPrefs(readAllEntries());
    if (!isDefaultPrefs(migrated)) adopt(migrated, { cacheLocally: true });
  }

  if (!remoteRequested) {
    remoteRequested = true;
    void getUserModuleSettings(ANALYTICS_PREFS_MODULE)
      .then((remote) => {
        if (remote == null) {
          // No row yet. If this browser carries something (a local record or a
          // migrated one), seed the per-user copy so a SECOND browser inherits
          // it — otherwise the reader would have to set everything again there.
          if (!isDefaultPrefs(current)) scheduleRemoteSave(current);
          return;
        }
        // `local` is at least as fresh as `remote` for the browser that made
        // the change — see `chooseStoredPrefs`. So the remote copy is adopted
        // only where this browser has nothing of its own.
        const chosen = chooseStoredPrefs(local, parseAnalyticsPrefs(remote));
        if (chosen !== local) adopt(chosen, { cacheLocally: true });
      })
      .catch(() => {
        // Signed out, offline, or the row is unreadable. The local copy is a
        // complete answer on its own.
      });
  }
}

export interface AnalyticsPrefsStore {
  prefs: AnalyticsPrefs;
  /** Change one or more settings. Merged over the current record. */
  patch(part: Partial<AnalyticsPrefs>): void;
  /** Everything back to the shipped defaults, here and in the database. */
  resetAll(): void;
  /** Anything at all is off the defaults — drives the Reset affordance. */
  customised: boolean;
  /**
   * Drop settings naming a year the payload no longer carries. Called ONCE by
   * the page shell with the page's own year list — never by a card, which
   * knows only its own row's years.
   */
  pruneYears(knownYears: readonly number[]): void;
}

export function useAnalyticsPrefs(): AnalyticsPrefsStore {
  const [prefs, setPrefs] = React.useState<AnalyticsPrefs>(current);

  React.useEffect(() => {
    const onLocal: Listener = (next) => setPrefs(next);
    listeners.add(onLocal);
    hydrate();
    // A record adopted by an earlier mount is already in `current`; sync to it
    // rather than waiting for the next change.
    setPrefs(current);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== ANALYTICS_PREFS_KEY) return;
      const next = readLocal();
      adopt(next ?? { ...DEFAULT_ANALYTICS_PREFS }, { cacheLocally: false });
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const patch = React.useCallback((part: Partial<AnalyticsPrefs>) => {
    commit({ ...current, ...part });
  }, []);

  const resetAll = React.useCallback(() => {
    commit({ ...DEFAULT_ANALYTICS_PREFS });
  }, []);

  const pruneYears = React.useCallback((knownYears: readonly number[]) => {
    const next = pruneAnalyticsPrefs(current, knownYears);
    // `pruneAnalyticsPrefs` returns the same reference when nothing moved, so
    // a clean record never writes and never re-renders.
    if (next !== current) commit(next);
  }, []);

  return {
    prefs,
    patch,
    resetAll,
    customised: !isDefaultPrefs(prefs),
    pruneYears,
  };
}

/**
 * TEST SEAM — reset the module singleton between fixture runs.
 *
 * Exported for the throwaway browser fixture and for a future test harness
 * only. The page itself never calls it: a module singleton with a public reset
 * that production code used would be a second way to change the record.
 */
export function __resetAnalyticsPrefsStoreForTests() {
  current = { ...DEFAULT_ANALYTICS_PREFS };
  hydrated = false;
  remoteRequested = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  emit();
}
