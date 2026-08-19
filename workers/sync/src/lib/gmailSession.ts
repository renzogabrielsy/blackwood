/**
 * gmailSession.ts — the ONE-IMAP-SESSION-PER-RUN broker (BUG-019, 2026-07-28).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS FIXES
 * ─────────────────────────────────────────────────────────────────────────────
 * `lib/gmail.ts` has stated the governing rule since Wave 4A — "the Mail Clerk depends
 * on ONE IMAP session for all four report types … Do NOT open a client per report" —
 * but NOTHING enforced it. In practice a single run opened SEVEN-plus sessions:
 *
 *   1  mailClerk.ts               the intended shared session          ✅
 *   4  reportDeps.makeLabeler     a NEW session on EVERY label call    ❌ (4 writers)
 *   1  reportDeps.makeFleconFetcher  its own session                   ❌
 *   1  prodSchedule/josephEmail   its own session                      ❌
 *
 * Gmail caps an account at ~15 simultaneous IMAP connections and answers
 * `NO [ALERT] Too many simultaneous connections. (Failure)` past that. Every sync run
 * started failing in 3–5s. imapflow reported it as `Error: Command failed` (the useful
 * text was on fields nobody read), and because imapflow ALSO stamps
 * `authenticationFailed: true` on it, the old `isAuthFailure` said "auth problem" —
 * which cost a full day and an unnecessary App-Password → OAuth migration, and made
 * `connect()` re-mint the token and open a SECOND socket on the very failure caused by
 * having too many sockets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DESIGN — a process-scoped, reference-counted broker
 * ─────────────────────────────────────────────────────────────────────────────
 * Threading the Mail Clerk's live client through to the labelers/fetchers is NOT
 * possible here: every report runs as its OWN DBOS child workflow, whose params must be
 * SERIALIZABLE (reportWorkflow.ts's contract — a live socket cannot cross a crash
 * boundary), and the Mail Clerk's session is a checkpointed step that has already
 * returned by the time the writers label. So this takes the documented alternative: a
 * module-scoped lazily-created shared client with reference counting.
 *
 *   - `withGmailSession(fn)` — acquires a lease, gets THE client (connecting on first
 *     use), runs `fn`, releases. Every Gmail caller in the worker uses this.
 *   - `withGmailRunLease(fn)` — `runSync` pins ONE lease for the whole run WITHOUT
 *     forcing a connect. It keeps the session alive across the Mail Clerk → writers →
 *     labelers span, so the run opens exactly ONE session instead of seven.
 *   - The session is closed EXACTLY ONCE, when the last lease is released — in a
 *     `finally`, so the error path and the DBOS-cancellation path both release it. A
 *     leaked session is the bug being fixed; this must not trade one leak for another.
 *
 * CONCURRENCY (Stage 2b runs four writers in parallel):
 *   - DBOS child workflows started with `DBOS.startWorkflow` run in THIS process, so a
 *     module-scoped broker really is shared by them (a queue-based fan-out would not
 *     change this — it would only ever REDUCE the connection count).
 *   - Concurrent `withGmailSession` calls are serialized through `chain` for the
 *     acquire/connect decision, so N racing callers produce exactly ONE `connect()`.
 *   - The IMAP commands themselves are safe to interleave on one connection because
 *     every `GmailClient` method takes `imap.getMailboxLock(ALL_MAIL)` for its whole
 *     critical section (search + per-UID fetch + attachment download all happen INSIDE
 *     the lock, and the download stream is fully buffered before release). imapflow's
 *     mailbox lock is exactly the documented mechanism for driving one connection from
 *     several concurrent code paths: the second caller's command queues behind the
 *     first instead of interleaving on the wire.
 *   - Liveness: a run can idle for minutes between the Mail Clerk and the labelers, and
 *     imapflow drops the socket after `socketTimeout`. Before handing the client out we
 *     check `client.usable`; a dead session is torn down (releasing its socket) and
 *     replaced. Still never more than one live connection at a time.
 *   - Fail-fast: if the connect fails, the failure is REMEMBERED for the rest of the
 *     lease generation (i.e. the rest of the run) and re-thrown to later callers WITHOUT
 *     opening another socket. During a connection-limit outage, four labelers must not
 *     become four more connection attempts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STOP TEARS DOWN THE SOCKET (BUG-026, 2026-08-19)
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASURED INCIDENT — run 35bfc6eb. 03:29:42 Run is clicked; the RC DELIVERIES IMAP
 * search takes **58 s** (4–7 s on every earlier run that day on the identical build —
 * Gmail was simply slow). 03:30:08 Stop is clicked; `sync_runs.status` flips to
 * `cancelled` at once. And then, at **03:32:57 — 2 min 49 s AFTER the cancel — the
 * cancelled run emitted `Found RC DELIVERIES (98 KB)`** and carried on downloading.
 *
 * THE REASON, and it is the whole lesson: **DBOS cancellation is observed only when a
 * step RETURNS.** The run was parked mid-`await` on an IMAP command inside
 * `DBOS.runStep`, so `DBOS.cancelWorkflow` had nothing to interrupt — it simply queued
 * behind Gmail. Cancelling a WORKFLOW does not cancel a SOCKET. Meanwhile the operator
 * clicked Run again at 03:31:05 and the second run opened a SECOND IMAP session on the
 * same account while the zombie still held the first — and Gmail throttles concurrent
 * sessions per account, so the new run was slower than the one it replaced.
 *
 * THE FIX — the broker owns an ABORT, and Stop pulls it:
 *   - Every `withGmailSession(fn)` body is RACED against a per-generation abort gate.
 *     `abortActiveGmailSession({runId})` rejects that gate FIRST (so the awaiting step
 *     rejects in ~0 ms, not when Gmail eventually answers) and only THEN tears the
 *     socket down. Rejecting before closing is deliberate: the operator's promptness
 *     must not depend on how fast a TLS FIN gets acknowledged.
 *   - The abort is STICKY for the generation. A labeler still unwinding inside a
 *     cancelled child workflow gets the same rejection instead of opening a fresh
 *     socket — the exact "zombie re-connects" shape this file already refuses for a
 *     failed connect. It is cleared only when a NEW run takes the lease.
 *   - The error is cancellation-SHAPED: `runSync.ts::isCancellation` recognises it, so
 *     the run settles `cancelled` (never `failed`) and the lease's `finally` closes the
 *     session exactly once, same as every other path.
 *   - `abortActiveGmailSession` is OWNER-CHECKED. A cancel for run B may never tear down
 *     run A's session; with the run gate (`workflows/runGate.ts`) there is only ever one
 *     live run, and this makes that structural rather than assumed.
 */
import {
  GmailClient,
  GmailOperationError,
  isGmailConnectionLimit,
  type GmailConnectOptions,
} from "./gmail.js";

/** How a session is built. Swappable in tests; production is `GmailClient.fromEnv`. */
export type GmailClientFactory = () => GmailClient;

/** What a caller receives — the live, connected client for the duration of `fn`. */
export type GmailSessionRunner = <T>(fn: (client: GmailClient) => Promise<T>) => Promise<T>;

/** Observable counters — the proof surface for "one session per run". */
export interface GmailSessionStats {
  /** How many times a real IMAP session was OPENED in this process. */
  opens: number;
  /** How many times a session was CLOSED. Must converge to `opens`. */
  closes: number;
  /** Outstanding leases right now. 0 ⇒ no session is held open. */
  leases: number;
  /** True while a live session exists. */
  open: boolean;
  /** The runId that pinned the current run lease, or null. */
  owner: string | null;
  /** True once Stop tore this generation down — sticky until a new run takes the lease. */
  aborted: boolean;
}

/**
 * The Gmail session was TORN DOWN mid-command because the run was Stopped (BUG-026).
 *
 * Deliberately its own error class rather than a reused DBOS one: the worker must be able
 * to say "this failed because a human pressed Stop" without importing the DBOS error
 * taxonomy into `lib/`, and `runSync.ts::isCancellation` folds it in at the one place that
 * already decides `cancelled` vs `failed`.
 */
export class GmailSessionAbortedError extends Error {
  /** The run that owned the torn-down session, when one was recorded. */
  readonly runId: string | null;
  constructor(message: string, runId: string | null = null) {
    super(message);
    this.name = "GmailSessionAborted";
    this.runId = runId;
  }
}

/**
 * True for the error above. Name-based as well as `instanceof`, so a copy that crossed a
 * DBOS serialization boundary (a child workflow's rejection reaches the parent as a
 * re-hydrated object, not the original instance) is still recognised as a Stop.
 */
export function isGmailSessionAborted(err: unknown): boolean {
  if (err instanceof GmailSessionAbortedError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "GmailSessionAborted"
  );
}

/** Default wording when a caller does not supply its own. */
const DEFAULT_ABORT_REASON =
  "The sync was stopped — the Gmail session was closed mid-command, so nothing further was fetched.";

class GmailSessionBroker {
  private factory: GmailClientFactory = () => GmailClient.fromEnv();
  private connectOptions: GmailConnectOptions = {};
  private client: GmailClient | null = null;
  private leases = 0;
  private opens = 0;
  private closes = 0;
  /** Sticky connect failure for the current lease generation (see the header). */
  private connectFailure: unknown = null;
  /** Serializes the acquire/connect decision so racing callers make ONE connection. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The runId that pinned the current run lease (`runLease`). Null outside a run. */
  private owner: string | null = null;
  /** Sticky Stop for this generation (BUG-026). Cleared only when a NEW run leases. */
  private aborted: GmailSessionAbortedError | null = null;
  /** Rejectors for every in-flight `run()` body — the thing that makes Stop immediate. */
  private abortWaiters: Array<(err: GmailSessionAbortedError) => void> = [];

  stats(): GmailSessionStats {
    return {
      opens: this.opens,
      closes: this.closes,
      leases: this.leases,
      open: this.client != null,
      owner: this.owner,
      aborted: this.aborted != null,
    };
  }

  /** Test seam. NEVER called in production code. */
  _configureForTest(opts: { factory?: GmailClientFactory; connect?: GmailConnectOptions }): void {
    if (opts.factory) this.factory = opts.factory;
    if (opts.connect) this.connectOptions = opts.connect;
  }

  /** Test seam — drops all state (does NOT close a live client; tests own their fakes). */
  _resetForTest(): void {
    this.factory = () => GmailClient.fromEnv();
    this.connectOptions = {};
    this.client = null;
    this.leases = 0;
    this.opens = 0;
    this.closes = 0;
    this.connectFailure = null;
    this.chain = Promise.resolve();
    this.owner = null;
    this.aborted = null;
    this.abortWaiters = [];
  }

  /** Run `fn` serialized against every other broker state transition. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // Swallow on the chain itself so one caller's rejection never poisons the next.
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Take a lease. A lease alone does NOT connect — it only pins the session open. */
  acquire(): Promise<void> {
    return this.serialize(async () => {
      // A fresh generation (nothing held) starts with a clean slate.
      if (this.leases === 0) this.connectFailure = null;
      this.leases += 1;
    });
  }

  /** Release a lease. The LAST release closes the session — exactly once. */
  release(): Promise<void> {
    return this.serialize(async () => {
      if (this.leases > 0) this.leases -= 1;
      if (this.leases > 0) return;
      this.connectFailure = null;
      await this.teardown();
    });
  }

  /**
   * Start a new run generation: record the owner and clear both sticky refusals.
   *
   * This — NOT `acquire`/`release` — is where `aborted` is cleared, and the difference is
   * load-bearing. A Stop rejects the run's Gmail call, the run lease's `finally` releases,
   * and a labeler inside a still-unwinding child workflow can call `withGmailSession`
   * AFTER that. If the abort died with the lease, that straggler would open a brand-new
   * socket for a run that was already stopped — the zombie, re-connected. So the abort
   * outlives the lease and dies only when a genuinely NEW run takes it.
   */
  private beginGeneration(runId: string | null): void {
    this.owner = runId;
    this.aborted = null;
    this.connectFailure = null;
  }

  /**
   * Tear the live session down NOW because the run was Stopped. Returns true if there was
   * something to abort. Never throws.
   *
   * ORDER MATTERS: the in-flight bodies are rejected FIRST, the socket closed SECOND.
   * Reversing it would make "how fast does Stop respond" a question about TLS teardown.
   */
  async abortActive(opts: { runId?: string | null; reason?: string } = {}): Promise<boolean> {
    // Nothing running and nothing open — a cancel for a run that never reached Gmail.
    if (this.leases === 0 && this.client == null && this.abortWaiters.length === 0) return false;
    // OWNER CHECK: a cancel for run B may never tear down run A's session.
    if (opts.runId && this.owner && this.owner !== opts.runId) return false;

    if (!this.aborted) {
      this.aborted = new GmailSessionAbortedError(opts.reason ?? DEFAULT_ABORT_REASON, this.owner);
    }
    const err = this.aborted;
    const waiters = this.abortWaiters;
    this.abortWaiters = [];
    for (const reject of waiters) {
      try {
        reject(err);
      } catch {
        /* a rejector cannot fail, but this must never break the teardown */
      }
    }
    await this.serialize(() => this.teardown());
    return true;
  }

  /**
   * Race `p` against this generation's abort gate. The gate only ever REJECTS, so a body
   * that finishes normally is completely unaffected — this adds a listener, never a timer
   * and never a poll.
   */
  private raceAbort<T>(p: Promise<T>): Promise<T> {
    if (this.aborted) return Promise.reject(this.aborted);
    let waiter!: (err: GmailSessionAbortedError) => void;
    const gate = new Promise<never>((_resolve, reject) => {
      waiter = reject;
      this.abortWaiters.push(reject);
    });
    // `Promise.race` subscribes to BOTH, so whichever loses is still "handled" — the
    // abandoned IMAP command's own rejection can never surface as an unhandled rejection.
    return Promise.race([p, gate]).finally(() => {
      const i = this.abortWaiters.indexOf(waiter);
      if (i >= 0) this.abortWaiters.splice(i, 1);
    });
  }

  /** THE client — connecting on first use, reused by everyone after that. */
  private ensureClient(): Promise<GmailClient> {
    return this.serialize(async () => {
      // Stop already happened. Never open a socket for a run that is being torn down.
      if (this.aborted) throw this.aborted;
      // A remembered failure short-circuits: never burn a second socket on a mailbox
      // that just refused us (the connection-limit case above all).
      if (this.connectFailure) throw this.connectFailure;
      // Reuse the live session. `usable === false` means imapflow dropped the socket
      // (idle timeout / server BYE) — tear it down before replacing it.
      if (this.client) {
        if (this.client.usable !== false) return this.client;
        await this.teardown();
      }
      const client = this.factory();
      try {
        await client.connect(this.connectOptions);
      } catch (err) {
        // connect() already released its own socket; make sure of it anyway, then
        // remember the failure for the rest of this lease generation.
        try {
          await client.close();
        } catch {
          /* best-effort */
        }
        this.connectFailure = err;
        throw err;
      }
      this.client = client;
      this.opens += 1;
      return client;
    });
  }

  /** Close the live session if there is one. Idempotent; never throws. */
  private async teardown(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    this.closes += 1;
    try {
      await client.close();
    } catch {
      /* close() is already best-effort; a throw here must not break a finally */
    }
  }

  async run<T>(fn: (client: GmailClient) => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const client = await this.ensureClient();
      // RACED, not merely awaited (BUG-026). A slow Gmail moment plus a Stop is exactly
      // the 2 min 49 s zombie in this file's header.
      return await this.raceAbort(fn(client));
    } finally {
      await this.release();
    }
  }

  /**
   * Pin the session for a whole run. `runId` is recorded so a `/cancel` for a DIFFERENT
   * run can never tear this one down, and so the sticky abort can tell "the run that was
   * stopped" from "the next run".
   *
   * NOT raced against the abort gate on purpose: the run BODY awaits DBOS child
   * workflows, and abandoning that promise would orphan them mid-flight. The Gmail call
   * is the thing that is stuck, so the Gmail call is the thing that gets interrupted —
   * the rejection then travels the ordinary error path all the way up.
   */
  async runLease<T>(fn: () => Promise<T>, opts: { runId?: string } = {}): Promise<T> {
    await this.acquire();
    this.beginGeneration(opts.runId ?? null);
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }
}

/** The ONE broker for this process. */
const broker = new GmailSessionBroker();

/**
 * Run `fn` against THE shared Gmail session. This is the ONLY sanctioned way to talk to
 * Gmail in the worker — do not construct a `GmailClient` anywhere else.
 */
export function withGmailSession<T>(fn: (client: GmailClient) => Promise<T>): Promise<T> {
  return broker.run(fn);
}

/**
 * Pin the shared session for the duration of `fn` WITHOUT forcing a connect. `runSync`
 * wraps the whole run in this so the Mail Clerk's session survives to the labelers and
 * the run opens exactly ONE session. Released in a `finally` — errors and DBOS
 * cancellations included.
 */
export function withGmailRunLease<T>(fn: () => Promise<T>, opts: { runId?: string } = {}): Promise<T> {
  return broker.runLease(fn, opts);
}

/**
 * STOP, reaching the socket (BUG-026). Rejects every in-flight `withGmailSession` body and
 * closes the live IMAP session immediately, so a run parked mid-search stops within
 * milliseconds instead of when Gmail eventually answers.
 *
 * Called by the kick server's `POST /cancel` handler — the ONE place a human's Stop
 * becomes a worker-side action. Owner-checked: passing `runId` guarantees this can only
 * tear down the session that run actually holds. Returns false when there was nothing to
 * abort (a cancel that arrived before the run reached Gmail, or after it finished), which
 * is a perfectly ordinary outcome and never an error.
 */
export function abortActiveGmailSession(
  opts: { runId?: string | null; reason?: string } = {},
): Promise<boolean> {
  return broker.abortActive(opts);
}

/** Counters for diagnostics + the "exactly one session" tests. */
export function gmailSessionStats(): GmailSessionStats {
  return broker.stats();
}

/** Test seams. Never called in production code. */
export function _configureGmailSessionForTest(opts: {
  factory?: GmailClientFactory;
  connect?: GmailConnectOptions;
}): void {
  broker._configureForTest(opts);
}
export function _resetGmailSessionForTest(): void {
  broker._resetForTest();
}

/**
 * Plain-English description of a Gmail failure for a progress beat / run finding.
 * Keeps the connection-limit case readable ("wait and retry"), and still carries the
 * server's own text for everything else — never `Error: Command failed`.
 */
export function describeGmailFailure(err: unknown): string {
  if (err instanceof GmailOperationError) return err.message;
  if (isGmailConnectionLimit(err)) {
    return new GmailOperationError("connect", err).message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Structurally the worker's `HeldRow` (workflows/normalizeReport.ts) — declared here so
 * this module stays free of the workflow layer. `kind` is deliberately typed as the
 * existing `HeldKind` string: that enum is FRONTEND-LOCKED (components/ carries an
 * exhaustive `Record<HeldKind, …>`), so a new category is expressed through
 * `reason`/`detail`, never a new kind.
 */
export interface GmailHeldRow {
  reason: string;
  natural_key: string;
  detail: string;
  kind: string;
  row: Record<string, unknown>;
}

/**
 * BUG-019 Fix 4 — turn a Gmail CONNECTION-LIMIT failure into a readable run FINDING.
 *
 * `apply.errors` never reaches the panel's honest findings list (`flattenRunFindings`
 * reads held rows + the reconciliation channels), so without this a connection-limit
 * failure shows only as a red card with an error string. One `gate_failure` held row
 * makes it a first-class finding an operator can read and act on. Any OTHER failure
 * returns `[]` — behaviour unchanged.
 */
export function gmailFailureHeldRows(cardKey: string, err: unknown): GmailHeldRow[] {
  if (!isGmailConnectionLimit(err)) return [];
  return [
    {
      // `reason` is what the panel renders as the finding TITLE when a held row carries
      // no batch code (lib/sync/findings.ts::fromHeld), so it is a plain sentence here,
      // not the usual slug. `detail` carries the server's own words underneath.
      reason:
        "Gmail refused the connection — too many are open on the sync mailbox right now. " +
        "Nothing was fetched or changed. Wait a few minutes and run the sync again.",
      natural_key: "Gmail · IMAP connection limit",
      detail: describeGmailFailure(err),
      kind: "gate_failure",
      row: { report: cardKey, remedy: "Wait a few minutes, then run the sync again." },
    },
  ];
}
