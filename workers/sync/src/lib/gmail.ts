/**
 * gmail.ts — Gmail IMAP client for the sync worker (imapflow + mailparser).
 *
 * Port of `.claude/skills/sync-ictc/scripts/fetch_gmail.py` (read as spec). The
 * Python used stdlib imaplib with raw X-GM-RAW / X-GM-LABELS / X-GM-THRID commands.
 * imapflow exposes those Gmail extensions as first-class options, so the wire
 * behavior is preserved while the code is far smaller:
 *
 *   - search:  search({ gmraw: "<gmail query>" }, { uid: true })  → X-GM-RAW.
 *              The Gmail query strings are copied VERBATIM from the orchestrators
 *              (label:"…" subject:"…" after:… -label:"Blackwood-Processed", etc.).
 *   - fetch:   fetch(uid, { uid, envelope, bodyStructure, source, threadId, labels })
 *   - download attachments: mailparser on the raw source (matches openpyxl-side
 *              expectations: we save the xlsx bytes to disk / return the buffer).
 *   - label:   messageFlagsAdd(uid, ["Blackwood-Processed"], { uid, useLabels: true })
 *              → +X-GM-LABELS (thread-scoped in Gmail, same as the Python).
 *   - pick-latest-xlsx: latestXlsx() reproduces orchestrator_common.latest_xlsx —
 *              UIDs ascending (newest last), walk from the newest, return the first
 *              email carrying an .xlsx/.xls attachment.
 *
 * SINGLE-CONNECTION SESSION REUSE: the Mail Clerk depends on ONE IMAP session for
 * all four report types (kills the Gmail burst-EOF problem). Open once with
 * `connect()`, run every search/download/label through that one client, then
 * `close()`. Do NOT open a client per report.
 *
 * ── AUTH (changed 2026-07-27: OAuth2/XOAUTH2 preferred, App Password fallback) ──
 * The old policy was "App Password only — never OAuth". That is REVERSED: on
 * 2026-07-27 Google started refusing the worker's App-Password IMAP login outright
 * (imapflow "Command failed"), which blocked every sync. OAuth2 is Google's endorsed
 * and durable path, so `gmailCredsFromEnv()` now resolves in this order:
 *
 *   1. OAuth  — GMAIL_USER + GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET +
 *               GMAIL_OAUTH_REFRESH_TOKEN. The refresh token is exchanged for a
 *               short-lived access token at https://oauth2.googleapis.com/token and
 *               handed to imapflow as `auth: { user, accessToken }` (XOAUTH2 is
 *               native to imapflow — this is an auth swap, NOT a Gmail-API rewrite).
 *               Access tokens are cached in module scope until 5 min before expiry.
 *   2. App Password — GMAIL_USER + GMAIL_APP_PASSWORD. Legacy fallback so that
 *               deploying this code BEFORE the OAuth secrets exist changes nothing,
 *               and so local dev keeps working off ~/.config/sync-ictc/credentials.env.
 *   3. Neither → throw, naming both option sets.
 *
 * SCOPE: the OAuth client MUST be granted the BROAD `https://mail.google.com/` scope.
 * Anything narrower (e.g. gmail.readonly) cannot do IMAP STORE, which would break the
 * `Blackwood-Processed` label write in markProcessed() — the sync's idempotency guard.
 *
 * The worker reads all of these from its env (Fly secrets), not from ~/.config, so the
 * Mac creds file is not a runtime dependency in production.
 */
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { simpleParser, type Attachment } from "mailparser";

export const PROCESSED_LABEL = "Blackwood-Processed";
const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
// "[Gmail]/All Mail" lets X-GM-RAW search across every label, matching fetch_gmail.py.
const ALL_MAIL = "[Gmail]/All Mail";
const MAX_BYTES_PER_MESSAGE = 50 * 1024 * 1024; // 50 MB cap, mirrors the Python.
// A genuine connect stall should ERROR quickly, not hang up to socketTimeout.
const CONNECT_TIMEOUT_MS = 60 * 1000;

/** Google's OAuth2 token endpoint (refresh_token → access_token exchange). */
const OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** The ONLY scope that permits full IMAP incl. STORE/+X-GM-LABELS (markProcessed). */
export const GMAIL_OAUTH_SCOPE = "https://mail.google.com/";
/** Treat an access token as expired this long before Google's stated expiry. */
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/**
 * How the worker authenticates to Gmail. OAuth is preferred; the App Password
 * branch is the legacy fallback (see the file header).
 */
export type GmailAuth =
  | {
      kind: "oauth";
      user: string;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    }
  | { kind: "appPassword"; user: string; appPassword: string };

/** @deprecated Legacy name kept for callers that still say `GmailCreds`. */
export type GmailCreds = GmailAuth;

/**
 * Resolve the Gmail auth config from env. Order: OAuth → App Password → throw.
 * `GMAIL_USER` (the single sync mailbox) is required in both branches.
 */
export function gmailCredsFromEnv(env: NodeJS.ProcessEnv = process.env): GmailAuth {
  const user = env.GMAIL_USER;
  const clientId = env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GMAIL_OAUTH_REFRESH_TOKEN;
  const appPassword = env.GMAIL_APP_PASSWORD;

  if (!user) {
    throw new Error("Missing GMAIL_USER in env (the sync mailbox address)");
  }
  if (clientId && clientSecret && refreshToken) {
    return { kind: "oauth", user, clientId, clientSecret, refreshToken };
  }
  if (appPassword) {
    return { kind: "appPassword", user, appPassword };
  }
  throw new Error(
    "Missing Gmail credentials in env. Set EITHER the OAuth trio " +
      "GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET + GMAIL_OAUTH_REFRESH_TOKEN " +
      `(scope ${GMAIL_OAUTH_SCOPE}; mint with \`npm run gmail:mint\`) ` +
      "OR the legacy GMAIL_APP_PASSWORD — alongside GMAIL_USER."
  );
}

// ---------------------------------------------------------------------------
// OAuth2 access-token minting + cache
// ---------------------------------------------------------------------------
interface CachedAccessToken {
  accessToken: string;
  /** Google's expiry MINUS the safety margin — refresh once we pass this. */
  refreshAfterMs: number;
}

/** Module-scoped cache, keyed by clientId+refreshToken (one entry per mailbox). */
const accessTokenCache = new Map<string, CachedAccessToken>();

function tokenCacheKey(auth: Extract<GmailAuth, { kind: "oauth" }>): string {
  return `${auth.clientId}\u0000${auth.refreshToken}`;
}

/** Test seam — drops every cached access token. Never called in production code. */
export function _resetAccessTokenCacheForTest(): void {
  accessTokenCache.clear();
}

/**
 * Exchange the refresh token for a short-lived access token, reusing the cached one
 * while it is still comfortably valid. Pass `{ forceRefresh: true }` to bypass the
 * cache (used by the connect() auth-failure retry).
 *
 * NEVER include the client secret or refresh token in a thrown message — only the
 * HTTP status and Google's own `error` / `error_description` fields.
 */
export async function getGmailAccessToken(
  auth: Extract<GmailAuth, { kind: "oauth" }>,
  opts: { forceRefresh?: boolean; now?: () => number } = {}
): Promise<string> {
  const now = opts.now ?? Date.now;
  const key = tokenCacheKey(auth);
  if (!opts.forceRefresh) {
    const hit = accessTokenCache.get(key);
    if (hit && now() < hit.refreshAfterMs) return hit.accessToken;
  }

  const body = new URLSearchParams({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    refresh_token: auth.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const payload = (parsed ?? {}) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok) {
    // Secret-safe: only status + Google's error fields, never the request body.
    const code = payload.error ?? (parsed ? "unknown_error" : "non_json_response");
    const desc = payload.error_description ? ` — ${payload.error_description}` : "";
    throw new Error(
      `Gmail OAuth token refresh failed (HTTP ${res.status}): ${code}${desc}. ` +
        `Re-mint with \`npm run gmail:mint\` if the refresh token was revoked.`
    );
  }
  if (!payload.access_token) {
    throw new Error(
      `Gmail OAuth token refresh returned HTTP ${res.status} with no access_token`
    );
  }

  const expiresInMs = (typeof payload.expires_in === "number" ? payload.expires_in : 3600) * 1000;
  accessTokenCache.set(key, {
    accessToken: payload.access_token,
    refreshAfterMs: now() + Math.max(0, expiresInMs - TOKEN_SAFETY_MARGIN_MS),
  });
  return payload.access_token;
}

/**
 * True when an imapflow throw looks like an AUTH rejection (as opposed to a network
 * or protocol failure). imapflow raises `AuthenticationFailure` with
 * `authenticationFailed: true`; Gmail's text is AUTHENTICATIONFAILED / "Invalid
 * credentials".
 */
export function isAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    authenticationFailed?: boolean;
    serverResponseCode?: string;
    response?: string;
    responseText?: string;
    message?: string;
  };
  if (e.authenticationFailed === true) return true;
  const hay = [e.serverResponseCode, e.response, e.responseText, e.message]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toUpperCase();
  return (
    hay.includes("AUTHENTICATIONFAILED") ||
    hay.includes("AUTHENTICATION FAILED") ||
    hay.includes("INVALID CREDENTIALS")
  );
}

export interface DownloadedAttachment {
  filename: string;
  /** Absolute path when saved to disk, else null (when returned as buffer only). */
  path: string | null;
  content: Buffer;
  sizeBytes: number;
  mimeType: string;
  isInline: boolean;
}

export interface FetchedEmail {
  uid: number;
  threadId: string | null;
  subject: string;
  sender: string;
  date: string | null; // ISO
  sizeBytes: number;
  attachments: DownloadedAttachment[];
  /**
   * True if this email carries a matching attachment, EVEN when its bytes were not
   * materialized. The attachment-only fast path (searchLatestAttachment) downloads
   * only the newest email's part but detects the part on every email via bodyStructure,
   * so this preserves the manifest's per-email hadAttachment signal without the full
   * download. Undefined on the full-source path (there, attachments.length is exact).
   */
  hasMatchingAttachment?: boolean;
}

export interface GmailSearchResult {
  ok: true;
  query: string;
  emailCount: number;
  emails: FetchedEmail[];
}

/**
 * One Gmail IMAP session. Construct, `connect()`, run any number of
 * `search`/`downloadAttachments`/`markProcessed`, then `close()`.
 */
export class GmailClient {
  /**
   * Null until connect(). The ImapFlow instance can no longer be built in the
   * constructor: the OAuth branch has to await an access-token fetch first.
   */
  private client: ImapFlow | null = null;
  private connected = false;
  private readonly auth: GmailAuth;

  constructor(creds: GmailAuth) {
    this.auth = creds;
  }

  static fromEnv(env?: NodeJS.ProcessEnv): GmailClient {
    return new GmailClient(gmailCredsFromEnv(env));
  }

  /** Which auth path this client will use — handy for diagnostics/log lines. */
  get authMode(): GmailAuth["kind"] {
    return this.auth.kind;
  }

  /** The single mailbox this client logs into (GMAIL_USER). */
  get mailbox(): string {
    return this.auth.user;
  }

  /** Null-safe accessor — every public method guards on `connected` first. */
  private get imap(): ImapFlow {
    if (!this.client) throw new Error("GmailClient used before connect()");
    return this.client;
  }

  private buildClient(secret: { pass?: string; accessToken?: string }): ImapFlow {
    return new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: this.auth.user, ...secret },
      // imapflow logs verbosely by default — silence to keep stdout/stderr clean.
      logger: false,
      // A genuine connect stall ERRORS at 60s instead of hanging to socketTimeout.
      connectionTimeout: CONNECT_TIMEOUT_MS,
      // Gmail can be slow on large mailboxes; keep a generous socket timeout for the
      // (rare) large single-message fetch — the per-report downloads are small.
      socketTimeout: 5 * 60 * 1000,
    });
  }

  /** Best-effort teardown of a client whose connect() threw. */
  private discardClient(): void {
    try {
      this.client?.close();
    } catch {
      /* best-effort */
    }
    this.client = null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.auth.kind === "appPassword") {
      this.client = this.buildClient({ pass: this.auth.appPassword });
      try {
        await this.client.connect();
      } catch (err) {
        this.discardClient();
        throw err;
      }
      this.connected = true;
      return;
    }

    // OAuth/XOAUTH2. Access tokens live ~1h; a cached one can go stale between runs
    // or be revoked, so an auth-shaped failure gets exactly ONE forced re-mint retry.
    const oauth = this.auth;
    this.client = this.buildClient({ accessToken: await getGmailAccessToken(oauth) });
    try {
      await this.client.connect();
    } catch (err) {
      this.discardClient();
      if (!isAuthFailure(err)) throw err;
      const fresh = await getGmailAccessToken(oauth, { forceRefresh: true });
      this.client = this.buildClient({ accessToken: fresh });
      try {
        await this.client.connect();
      } catch (retryErr) {
        this.discardClient();
        throw retryErr; // no loop — one retry only.
      }
    }
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected || !this.client) {
      this.connected = false;
      return;
    }
    try {
      await this.client.logout();
    } catch {
      // Best-effort — mirror the Python's try/except logout().
    } finally {
      this.connected = false;
    }
  }

  /**
   * Search "[Gmail]/All Mail" with a Gmail-syntax query via X-GM-RAW, download
   * matching attachments to `outDir` (or return buffers if outDir is null), and
   * return the manifest. UIDs are returned ascending (newest last) exactly like
   * fetch_gmail.py, and capped to `limit` newest.
   *
   * @param patterns comma-list of globs, default "*.xlsx,*.xls" (case-insensitive).
   */
  async search(
    gmailQuery: string,
    opts: {
      outDir?: string | null;
      patterns?: string[];
      limit?: number;
    } = {}
  ): Promise<GmailSearchResult> {
    if (!this.connected) throw new Error("GmailClient.search called before connect()");
    const patterns = (opts.patterns && opts.patterns.length
      ? opts.patterns
      : ["*.xlsx", "*.xls"]
    ).map((p) => p.toLowerCase());
    const limit = opts.limit ?? 50;

    const lock = await this.imap.getMailboxLock(ALL_MAIL);
    try {
      // X-GM-RAW search. imapflow returns UIDs (numbers) when { uid: true }.
      const found = await this.imap.search({ gmraw: gmailQuery }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice().sort((a, b) => a - b);
      if (!uids.length) {
        return { ok: true, query: gmailQuery, emailCount: 0, emails: [] };
      }
      const chosen = limit && uids.length > limit ? uids.slice(-limit) : uids;

      const emails: FetchedEmail[] = [];
      for (const uid of chosen) {
        const msg = (await this.imap.fetchOne(
          String(uid),
          { uid: true, envelope: true, size: true, source: true, threadId: true },
          { uid: true }
        )) as FetchMessageObject | false;
        if (!msg) continue;

        const size = typeof msg.size === "number" ? msg.size : 0;
        if (size > MAX_BYTES_PER_MESSAGE) {
          // Skip oversized message, but still record it — matches the Python.
          emails.push({
            uid,
            threadId: msg.threadId ?? null,
            subject: msg.envelope?.subject ?? "",
            sender: formatAddress(msg.envelope?.from),
            date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
            sizeBytes: size,
            attachments: [],
          });
          continue;
        }

        const source = msg.source;
        if (!source) continue;
        const parsed = await simpleParser(source);
        const attachments = await saveMatchingAttachments(
          parsed.attachments ?? [],
          patterns,
          opts.outDir ?? null,
          uid
        );

        emails.push({
          uid,
          threadId: msg.threadId ?? null,
          subject: msg.envelope?.subject ?? parsed.subject ?? "",
          sender: formatAddress(msg.envelope?.from) || parsed.from?.text || "",
          date: msg.envelope?.date
            ? new Date(msg.envelope.date).toISOString()
            : parsed.date
            ? parsed.date.toISOString()
            : null,
          sizeBytes: size,
          attachments,
        });
      }
      return { ok: true, query: gmailQuery, emailCount: emails.length, emails };
    } finally {
      lock.release();
    }
  }

  /**
   * FAST attachment-only variant of `search`. Instead of pulling every matching
   * message's FULL rfc822 source (slow — the 2m40s culprit) and mailparser-parsing
   * all of it, this:
   *   1. fetches lightweight metadata (envelope + size + bodyStructure) for the
   *      matching UIDs — no source bytes,
   *   2. picks the NEWEST email carrying an xlsx/xls attachment part,
   *   3. downloads ONLY that one part via `download(uid, part)` (imapflow decodes
   *      base64/quoted-printable for us, so the bytes are byte-identical to what
   *      mailparser returned from the full source).
   *
   * Returns the SAME { emails } shape as `search`, so pickLatestXlsx / the manifest
   * are unchanged. Only the CHOSEN email carries a materialized attachment buffer;
   * older emails are metadata-only (they were never used anyway — the clerk always
   * takes the latest). On ANY per-message structure/part failure the caller can fall
   * back to the full-source `search` for that query (correctness beats speed).
   *
   * @param patterns comma-list of globs, default "*.xlsx,*.xls" (case-insensitive).
   */
  async searchLatestAttachment(
    gmailQuery: string,
    opts: { patterns?: string[]; limit?: number } = {}
  ): Promise<GmailSearchResult> {
    if (!this.connected)
      throw new Error("GmailClient.searchLatestAttachment called before connect()");
    const patterns = (opts.patterns && opts.patterns.length
      ? opts.patterns
      : ["*.xlsx", "*.xls"]
    ).map((p) => p.toLowerCase());
    const limit = opts.limit ?? 50;

    const lock = await this.imap.getMailboxLock(ALL_MAIL);
    try {
      const found = await this.imap.search({ gmraw: gmailQuery }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice().sort((a, b) => a - b);
      if (!uids.length) {
        return { ok: true, query: gmailQuery, emailCount: 0, emails: [] };
      }
      const chosen = limit && uids.length > limit ? uids.slice(-limit) : uids;

      // Pass 1 — metadata only (envelope + size + bodyStructure). Cheap: no source.
      const metas: {
        uid: number;
        msg: FetchMessageObject;
        attPart: { part: string; filename: string } | null;
      }[] = [];
      for (const uid of chosen) {
        const msg = (await this.imap.fetchOne(
          String(uid),
          { uid: true, envelope: true, size: true, bodyStructure: true, threadId: true },
          { uid: true }
        )) as FetchMessageObject | false;
        if (!msg) continue;
        const attPart = msg.bodyStructure
          ? findAttachmentPart(msg.bodyStructure, patterns)
          : null;
        metas.push({ uid, msg, attPart });
      }

      // Build the emails list (metadata-only), newest last (metas are UID-ascending).
      const emails: FetchedEmail[] = metas.map(({ uid, msg, attPart }) => ({
        uid,
        threadId: msg.threadId ?? null,
        subject: msg.envelope?.subject ?? "",
        sender: formatAddress(msg.envelope?.from),
        date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
        sizeBytes: typeof msg.size === "number" ? msg.size : 0,
        attachments: [],
        // Preserve the per-email hadAttachment signal without downloading every part.
        hasMatchingAttachment: attPart != null,
      }));

      // Pass 2 — download ONLY the newest email's attachment part.
      for (let i = metas.length - 1; i >= 0; i--) {
        const m = metas[i];
        if (!m.attPart) continue;
        const size = typeof m.msg.size === "number" ? m.msg.size : 0;
        if (size > MAX_BYTES_PER_MESSAGE) {
          // Oversized — record the email (already in `emails`) but skip the download.
          break;
        }
        const dl = await this.imap.download(String(m.uid), m.attPart.part, {
          uid: true,
        });
        const content = await streamToBuffer(dl.content);
        emails[i].attachments = [
          {
            filename: dl.meta.filename || m.attPart.filename,
            path: null,
            content,
            sizeBytes: content.length,
            mimeType:
              dl.meta.contentType ||
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            isInline: (dl.meta.disposition ?? "").toLowerCase().includes("inline"),
          },
        ];
        break; // only the newest xlsx is needed
      }

      return { ok: true, query: gmailQuery, emailCount: emails.length, emails };
    } finally {
      lock.release();
    }
  }

  /**
   * Apply the Blackwood-Processed Gmail LABEL to the given UIDs (thread-scoped).
   * Uses +X-GM-LABELS via messageFlagsAdd(..., { useLabels: true }). Call this ONLY
   * when the apply had zero errors and zero unapplied non-held rows
   * (SKILL.md:347 discipline — enforced by the caller, not here).
   */
  async markProcessed(uids: Array<number | string>): Promise<boolean> {
    if (!this.connected) throw new Error("markProcessed called before connect()");
    const clean = uids.map((u) => String(u)).filter(Boolean);
    if (!clean.length) return false;
    const lock = await this.imap.getMailboxLock(ALL_MAIL);
    try {
      const ok = await this.imap.messageFlagsAdd(clean.join(","), [PROCESSED_LABEL], {
        uid: true,
        useLabels: true,
      });
      return Boolean(ok);
    } finally {
      lock.release();
    }
  }
}

/**
 * From a search result, pick the LATEST email that carries an xlsx attachment
 * (emails are UID-ascending, newest last). Returns { path, buffer, email } or null.
 * Deterministic — mirrors orchestrator_common.latest_xlsx.
 */
export function latestXlsx(
  result: GmailSearchResult
): { attachment: DownloadedAttachment; email: FetchedEmail } | null {
  for (let i = result.emails.length - 1; i >= 0; i--) {
    const em = result.emails[i];
    for (const att of em.attachments) {
      const name = att.filename.toLowerCase();
      if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
        return { attachment: att, email: em };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function saveMatchingAttachments(
  attachments: Attachment[],
  patterns: string[],
  outDir: string | null,
  uid: number
): Promise<DownloadedAttachment[]> {
  const out: DownloadedAttachment[] = [];
  for (const att of attachments) {
    const rawName = att.filename ?? "";
    if (!rawName) continue;
    const lower = rawName.toLowerCase();
    if (!patterns.some((p) => globMatch(lower, p))) continue;

    const content = att.content as Buffer;
    let savedPath: string | null = null;
    if (outDir) {
      const { mkdir, writeFile, chmod } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(outDir, { recursive: true });
      // Prefix with UID so files from different emails don't collide (Python parity).
      const target = join(outDir, `${uid}_${safeFilename(rawName)}`);
      await writeFile(target, content);
      try {
        await chmod(target, 0o600);
      } catch {
        /* best-effort */
      }
      savedPath = target;
    }
    out.push({
      filename: rawName,
      path: savedPath,
      content,
      sizeBytes: content.length,
      mimeType: att.contentType ?? "application/octet-stream",
      isInline: (att.contentDisposition ?? "").toLowerCase().includes("inline"),
    });
  }
  return out;
}

/**
 * Walk a bodyStructure tree and return the FIRST leaf part that looks like an
 * attachment matching one of the filename globs (case-insensitive). Returns the
 * IMAP part number (e.g. "2") + the filename, or null if none. Mirrors the
 * mailparser attachment-filter used by the full-source path, but off the structure
 * so we can download just that one part.
 */
export function findAttachmentPart(
  node: MessageStructureObject,
  patterns: string[]
): { part: string; filename: string } | null {
  if (node.childNodes && node.childNodes.length) {
    for (const child of node.childNodes) {
      const hit = findAttachmentPart(child, patterns);
      if (hit) return hit;
    }
    return null;
  }
  // Leaf node. Its filename lives on the Content-Disposition params, or (fallback)
  // the Content-Type "name" param.
  const name =
    node.dispositionParameters?.filename ??
    node.dispositionParameters?.Filename ??
    node.parameters?.name ??
    node.parameters?.Name ??
    "";
  if (!name || !node.part) return null;
  const lower = String(name).toLowerCase();
  if (!patterns.some((p) => globMatch(lower, p))) return null;
  return { part: node.part, filename: String(name) };
}

/** Buffer a Readable stream (imapflow's download().content). */
async function streamToBuffer(stream: import("node:stream").Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Port of fetch_gmail.safe_filename: basename, strip unsafe chars, cap length. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  let cleaned = base.replace(/[^A-Za-z0-9 ._-]/g, "_").trim();
  if (!cleaned) cleaned = "attachment";
  if (cleaned.length > 200) {
    const dot = cleaned.lastIndexOf(".");
    const ext = dot >= 0 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, 200 - ext.length) + ext;
  }
  return cleaned;
}

/** Minimal fnmatch-equivalent for the "*.xlsx" style globs the sync uses. */
export function globMatch(name: string, pattern: string): boolean {
  // Escape regex specials except * and ?, then translate.
  const re =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  return new RegExp(re, "i").test(name);
}

function formatAddress(
  addr: { name?: string; address?: string } | Array<{ name?: string; address?: string }> | undefined
): string {
  if (!addr) return "";
  const first = Array.isArray(addr) ? addr[0] : addr;
  if (!first) return "";
  if (first.name && first.address) return `${first.name} <${first.address}>`;
  return first.address ?? first.name ?? "";
}
