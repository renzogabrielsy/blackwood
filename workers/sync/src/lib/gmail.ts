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
 * Credentials: GMAIL_USER + GMAIL_APP_PASSWORD from env (App Password only — never
 * OAuth). The worker reads them from its env, not from ~/.config, so the Mac creds
 * file is not a runtime dependency in production.
 */
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type Attachment } from "mailparser";

export const PROCESSED_LABEL = "Blackwood-Processed";
const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
// "[Gmail]/All Mail" lets X-GM-RAW search across every label, matching fetch_gmail.py.
const ALL_MAIL = "[Gmail]/All Mail";
const MAX_BYTES_PER_MESSAGE = 50 * 1024 * 1024; // 50 MB cap, mirrors the Python.

export interface GmailCreds {
  user: string;
  appPassword: string;
}

export function gmailCredsFromEnv(env: NodeJS.ProcessEnv = process.env): GmailCreds {
  const user = env.GMAIL_USER;
  const appPassword = env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error(
      "Missing GMAIL_USER or GMAIL_APP_PASSWORD in env (Gmail App Password auth only)"
    );
  }
  return { user, appPassword };
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
  private client: ImapFlow;
  private connected = false;

  constructor(creds: GmailCreds) {
    this.client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: creds.user, pass: creds.appPassword },
      // imapflow logs verbosely by default — silence to keep stdout/stderr clean.
      logger: false,
      // Gmail can be slow on large mailboxes; give a generous socket timeout.
      socketTimeout: 5 * 60 * 1000,
    });
  }

  static fromEnv(env?: NodeJS.ProcessEnv): GmailClient {
    return new GmailClient(gmailCredsFromEnv(env));
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
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

    const lock = await this.client.getMailboxLock(ALL_MAIL);
    try {
      // X-GM-RAW search. imapflow returns UIDs (numbers) when { uid: true }.
      const found = await this.client.search({ gmraw: gmailQuery }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice().sort((a, b) => a - b);
      if (!uids.length) {
        return { ok: true, query: gmailQuery, emailCount: 0, emails: [] };
      }
      const chosen = limit && uids.length > limit ? uids.slice(-limit) : uids;

      const emails: FetchedEmail[] = [];
      for (const uid of chosen) {
        const msg = (await this.client.fetchOne(
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
   * Apply the Blackwood-Processed Gmail LABEL to the given UIDs (thread-scoped).
   * Uses +X-GM-LABELS via messageFlagsAdd(..., { useLabels: true }). Call this ONLY
   * when the apply had zero errors and zero unapplied non-held rows
   * (SKILL.md:347 discipline — enforced by the caller, not here).
   */
  async markProcessed(uids: Array<number | string>): Promise<boolean> {
    if (!this.connected) throw new Error("markProcessed called before connect()");
    const clean = uids.map((u) => String(u)).filter(Boolean);
    if (!clean.length) return false;
    const lock = await this.client.getMailboxLock(ALL_MAIL);
    try {
      const ok = await this.client.messageFlagsAdd(clean.join(","), [PROCESSED_LABEL], {
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
