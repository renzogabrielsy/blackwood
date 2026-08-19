/**
 * runGate.ts — ONE RUN AT A TIME, enforced at the door (BUG-026, 2026-08-19).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INCIDENT
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-08-19, run 35bfc6eb. A slow Gmail search (58 s) made the run look hung; the
 * operator pressed Stop at 03:30:08, and — because a cancelled workflow was still parked
 * mid-IMAP-command — pressed **Run again at 03:31:05**. Run 1a3bd336 started while the
 * first was still holding a live IMAP session, so the account carried TWO simultaneous
 * sessions. Gmail throttles concurrent IMAP sessions per account, so the second run's
 * `Looking for RC DELIVERIES…` sat for three and a half minutes — slower than the run it
 * was meant to replace. The retry made things worse, which is the worst property a retry
 * can have.
 *
 * `lib/gmailSession.ts` guarantees ONE session per *process generation*; it cannot
 * guarantee one *run*, because two overlapping runs are two legitimate lease generations.
 * That has to be decided a level up, and this is that level.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE
 * ─────────────────────────────────────────────────────────────────────────────
 * A run holds the slot from before it takes the Gmail run-lease until after that lease is
 * RELEASED. So the slot covers the whole window in which a run can touch Gmail — including
 * the tail of a run that is still unwinding from a Stop, which is exactly the window the
 * operator's second click landed in.
 *
 * **It QUEUES, it does not refuse.** The click is already durable (`sync_runs` row,
 * status `queued`) and the panel already renders that state, so parking the workflow until
 * the slot frees costs the operator nothing and loses nothing — whereas refusing would
 * turn a two-second overlap into "click again yourself". A queued run emits one
 * plain-English beat saying what it is waiting for, so the wait is never mistaken for a
 * hang (which is the mistake that started this whole incident).
 *
 * Three properties worth stating because each one is a bug if it goes the other way:
 *
 *   1. **RE-ENTRANT for the same runId.** DBOS recovers/replays a workflow by re-running
 *      its body; a run that already holds the slot must not deadlock against itself.
 *   2. **FIFO.** Waiters are woken in arrival order, so a queue cannot starve its oldest
 *      member.
 *   3. **BOUNDED.** A predecessor that never releases (a crashed process would have taken
 *      this module's state with it, but a wedged one would not) must not park its
 *      successor forever. The cap is the watchdog's own staleness horizon — past that
 *      point `selfHeal.ts` has already expired the predecessor, so waiting longer is
 *      waiting on a run the system has given up on.
 */

/** How long a run will queue behind another before giving up, in ms.
 *
 *  Deliberately the same horizon as `selfHeal.ts::STALE_RUN_MINUTES` (15): past it the
 *  watchdog has already declared the predecessor dead, so a longer wait would be a wait on
 *  a run nothing else in the system still believes in. Not imported from `selfHeal.ts` —
 *  that module pulls in DBOS and the whole runSync graph, and this one must stay a leaf. */
export const RUN_SLOT_TIMEOUT_MS = 15 * 60 * 1000;

interface Waiter {
  runId: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** What `acquire` did — surfaced so a caller can log/emit only when it actually waited. */
export type RunSlotOutcome = "immediate" | "queued" | "reentrant";

export interface RunSlotOptions {
  /** Override the queue cap (tests). */
  timeoutMs?: number;
  /**
   * Called ONCE, at the moment this run is parked, with the runId already holding the
   * slot. The natural home for the "waiting for the previous sync" progress beat. Must
   * never throw into the gate — the gate swallows anyway.
   */
  onWait?: (activeRunId: string) => void | Promise<void>;
}

class RunGate {
  private active: string | null = null;
  /** Re-entrancy depth for `active`. Only 0 → the slot is genuinely free. */
  private depth = 0;
  private waiters: Waiter[] = [];

  /** The runId currently holding the slot, or null. Diagnostics + tests. */
  activeRun(): string | null {
    return this.active;
  }

  /** How many runs are parked behind the active one. Diagnostics + tests. */
  waiting(): number {
    return this.waiters.length;
  }

  async acquire(runId: string, opts: RunSlotOptions = {}): Promise<RunSlotOutcome> {
    if (this.active === runId) {
      this.depth += 1;
      return "reentrant";
    }
    if (this.active === null) {
      this.active = runId;
      this.depth = 1;
      return "immediate";
    }

    const holder = this.active;
    const timeoutMs = opts.timeoutMs ?? RUN_SLOT_TIMEOUT_MS;
    const gate = new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          new Error(
            `Another sync (run ${holder}) was still running after ` +
              `${Math.round(timeoutMs / 60000)} minutes, so this run never started. ` +
              `Nothing was fetched and nothing was changed. Stop that run, or try again once it finishes.`,
          ),
        );
      }, timeoutMs);
      // Do not hold the process open just because a run is queued.
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });

    if (opts.onWait) {
      try {
        await opts.onWait(holder);
      } catch {
        /* the beat is observational — it must never decide whether a run may start */
      }
    }
    await gate;
    return "queued";
  }

  /** Hand the slot on. Idempotent-ish: releasing a slot you don't hold is a no-op. */
  release(runId: string): void {
    if (this.active !== runId) return;
    if (this.depth > 1) {
      this.depth -= 1;
      return;
    }
    this.active = null;
    this.depth = 0;
    const next = this.waiters.shift();
    if (!next) return;
    if (next.timer) clearTimeout(next.timer);
    this.active = next.runId;
    this.depth = 1;
    next.resolve();
  }

  /** Test seam. NEVER called in production code. */
  _resetForTest(): void {
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer);
    }
    this.waiters = [];
    this.active = null;
    this.depth = 0;
  }
}

/** THE gate for this process. */
const gate = new RunGate();

/**
 * Run `fn` holding the one run slot, queueing behind whatever holds it. Released in a
 * `finally` — success, failure and cancellation alike, exactly like the Gmail run lease it
 * wraps. Wrapping (rather than sitting beside) the lease is what makes the slot cover a
 * cancelled run's unwind.
 */
export async function withRunSlot<T>(
  runId: string,
  fn: () => Promise<T>,
  opts: RunSlotOptions = {},
): Promise<T> {
  await gate.acquire(runId, opts);
  try {
    return await fn();
  } finally {
    gate.release(runId);
  }
}

/** The runId currently holding the slot, or null. */
export function activeRunSlot(): string | null {
  return gate.activeRun();
}

/** How many runs are parked behind the active one. */
export function queuedRunSlots(): number {
  return gate.waiting();
}

/** Test seam. NEVER called in production code. */
export function _resetRunGateForTest(): void {
  gate._resetForTest();
}
