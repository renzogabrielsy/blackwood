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
}

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

  stats(): GmailSessionStats {
    return { opens: this.opens, closes: this.closes, leases: this.leases, open: this.client != null };
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

  /** THE client — connecting on first use, reused by everyone after that. */
  private ensureClient(): Promise<GmailClient> {
    return this.serialize(async () => {
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
      return await fn(client);
    } finally {
      await this.release();
    }
  }

  async runLease<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
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
export function withGmailRunLease<T>(fn: () => Promise<T>): Promise<T> {
  return broker.runLease(fn);
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
