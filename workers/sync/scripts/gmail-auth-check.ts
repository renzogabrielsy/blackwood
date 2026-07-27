/**
 * gmail-auth-check.ts — LOCAL, READ-ONLY proof that the worker's Gmail auth works.
 *
 *   npm run gmail:check
 *
 * Builds GmailClient.fromEnv(), prints which auth mode resolved (oauth vs the legacy
 * appPassword fallback) and the mailbox, connects, runs ONE trivial search, and logs
 * out. It never downloads a workbook, never writes to Supabase, and never applies the
 * Blackwood-Processed label — safe against the production mailbox.
 *
 * Creds: same loader as scripts/mailclerk-live-test.ts — env first, then
 * ~/.config/sync-ictc/credentials.env, then workers/sync/.env.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GmailClient } from "../src/lib/gmail.js";

function loadEnvFile(path: string): void {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      const v = t
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // Missing file is fine — the other source (or a clear throw) covers it.
  }
}

function loadDevCreds(): void {
  loadEnvFile(join(homedir(), ".config", "sync-ictc", "credentials.env"));
  loadEnvFile(join(dirname(dirname(fileURLToPath(import.meta.url))), ".env"));
}

async function main(): Promise<void> {
  loadDevCreds();

  const client = GmailClient.fromEnv();
  const mode =
    client.authMode === "oauth"
      ? "OAuth2 / XOAUTH2 (GMAIL_OAUTH_CLIENT_ID + _SECRET + _REFRESH_TOKEN)"
      : "App Password (legacy fallback — GMAIL_APP_PASSWORD)";
  // eslint-disable-next-line no-console
  console.log(`[gmail-auth-check] auth mode : ${mode}`);
  // eslint-disable-next-line no-console
  console.log(`[gmail-auth-check] mailbox   : ${client.mailbox}`);

  const t0 = Date.now();
  await client.connect();
  // eslint-disable-next-line no-console
  console.log(`[gmail-auth-check] connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  try {
    // Trivial, cheap probe: newest 1 message from the last 2 days, metadata only.
    const since = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    const q =
      `after:${since.getUTCFullYear()}/${String(since.getUTCMonth() + 1).padStart(2, "0")}/` +
      `${String(since.getUTCDate()).padStart(2, "0")} has:attachment`;
    const res = await client.searchLatestAttachment(q, { limit: 1 });
    // eslint-disable-next-line no-console
    console.log(
      `[gmail-auth-check] search OK   : "${q}" → ${res.emailCount} email(s) matched`
    );
  } finally {
    await client.close();
  }

  // eslint-disable-next-line no-console
  console.log("[gmail-auth-check] PASS — Gmail auth is working.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[gmail-auth-check] FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
