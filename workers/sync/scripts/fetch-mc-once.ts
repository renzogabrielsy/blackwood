/**
 * fetch-mc-once.ts — ONE read-only Gmail session that downloads the latest MC
 * "Daily Production Report" attachment to a local path, for offline dry-running the
 * production extractor.
 *
 * STRICTLY READ-ONLY: it opens exactly one session via the shared broker
 * (`withGmailSession` — the only sanctioned way to reach Gmail, BUG-019), runs ONLY
 * the `production_mc` query, and NEVER labels, NEVER uploads to Storage, NEVER
 * touches the DB. Gmail's per-account session budget is tight, so this exists so a
 * developer never hand-rolls a second connection.
 *
 * Usage:
 *   npx tsx scripts/fetch-mc-once.ts <since YYYY/MM/DD> <output.xlsx>
 */
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { withGmailSession, gmailSessionStats } from "../src/lib/gmailSession.js";
import { mailQueries } from "../src/workflows/mailClerk.js";

function loadDevCreds(): void {
  if (process.env.GMAIL_USER && (process.env.GMAIL_OAUTH_REFRESH_TOKEN || process.env.GMAIL_APP_PASSWORD)) {
    return;
  }
  const p = join(homedir(), ".config", "sync-ictc", "credentials.env");
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadDevCreds();
  const since = process.argv[2];
  const out = process.argv[3];
  if (!since || !out) {
    throw new Error("usage: tsx scripts/fetch-mc-once.ts <since YYYY/MM/DD> <output.xlsx>");
  }

  const q = mailQueries().find((x) => x.key === "production_mc");
  if (!q) throw new Error("production_mc query missing from mailQueries()");
  const query = q.query.replace("{since}", since);
  console.log(`[fetch-mc-once] READ-ONLY, ONE session. query: ${query}`);

  const res = await withGmailSession((client) =>
    client.searchLatestAttachment(query, { patterns: ["*.xlsx", "*.xls"] })
  );

  console.log(`[fetch-mc-once] ${res.emailCount} matching email(s)`);
  for (const em of res.emails) {
    console.log(
      `    uid=${em.uid}  ${em.date ?? "(no date)"}  ${em.subject}  ` +
        `attachments=${em.attachments.map((a) => `${a.filename} (${a.sizeBytes}B)`).join(", ") || "(none downloaded)"}`
    );
  }

  // Same selection rule as mailClerk::pickLatestXlsx — newest email, first xlsx part.
  let picked: { filename: string; content: Buffer; uid: number } | null = null;
  for (let i = res.emails.length - 1; i >= 0 && picked === null; i--) {
    const em = res.emails[i];
    for (const att of em.attachments) {
      const n = att.filename.toLowerCase();
      if (n.endsWith(".xlsx") || n.endsWith(".xls")) {
        picked = { filename: att.filename, content: att.content, uid: em.uid };
        break;
      }
    }
  }
  if (!picked) throw new Error("no xlsx attachment found for the production_mc query");

  await writeFile(out, picked.content);
  console.log(
    `[fetch-mc-once] wrote ${out}  (${picked.filename}, ${picked.content.length} bytes, uid ${picked.uid})`
  );
  const s = gmailSessionStats();
  console.log(`[fetch-mc-once] gmail sessions opened this process: ${JSON.stringify(s)}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[fetch-mc-once] FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
