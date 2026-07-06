/**
 * mailclerk-live-test.ts — M1 live, READ-ONLY test of the Mail Clerk against the
 * REAL mailbox. It runs the exact Mail Clerk body over ONE Gmail session, fetching
 * the latest attachment for each of the report queries, and prints the manifest.
 *
 * READ-ONLY: dryRun=true, so it NEVER uploads to Storage and NEVER applies the
 * Blackwood-Processed label (the clerk never labels anyway — labeling is a separate
 * apply-phase step). Safe to run against production Gmail.
 *
 * Creds: reads GMAIL_USER / GMAIL_APP_PASSWORD from env; the wrapper below loads
 * them from ~/.config/sync-ictc/credentials.env if not already set (dev convenience;
 * in prod they come from the worker's env / Fly secrets).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { _mailClerkBodyForTest, mailQueries } from "../src/workflows/mailClerk.js";

function loadDevCreds(): void {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return;
  const p = join(homedir(), ".config", "sync-ictc", "credentials.env");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // ignore — will fail clearly at connect() if creds truly missing.
  }
}

async function main(): Promise<void> {
  loadDevCreds();
  const since = process.env.SINCE ?? defaultSince();
  // eslint-disable-next-line no-console
  console.log(`[mailclerk-live] READ-ONLY run, since=${since}`);
  // eslint-disable-next-line no-console
  console.log(
    `[mailclerk-live] queries:\n` +
      mailQueries()
        .map((q) => `  - ${q.key} (${q.role}): ${q.query.replace("{since}", since)}`)
        .join("\n")
  );

  const t0 = Date.now();
  // Console progress logger — proves the per-report progress lines fire during fetch.
  const onProgress = async (
    _stage: "fetch",
    label: string,
    pct: number,
    detail?: string,
    level: "info" | "warn" = "info"
  ): Promise<void> => {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const tag = level === "warn" ? "WARN" : "prog";
    // eslint-disable-next-line no-console
    console.log(
      `[mailclerk-live][${tag}] +${secs}s  ${String(pct).padStart(3)}%  ${label}` +
        (detail ? `  (${detail})` : "")
    );
  };

  const manifest = await _mailClerkBodyForTest(
    {
      runId: `live-test-${Date.now()}`,
      since,
      dryRun: true, // never upload to Storage, never label
    },
    onProgress
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // eslint-disable-next-line no-console
  console.log(`\n[mailclerk-live] completed in ${secs}s over ONE Gmail session\n`);
  // eslint-disable-next-line no-console
  console.log("=== MANIFEST ===");
  for (const [key, atts] of Object.entries(manifest.reports)) {
    if (atts.length) {
      for (const a of atts) {
        // eslint-disable-next-line no-console
        console.log(
          `  ${key}: ${a.filename} (${a.sizeBytes} bytes) ` +
            `from uid=${a.emailUid} "${a.emailSubject}" ${a.emailDate ?? ""} ` +
            `-> would upload to sync-inbox/${a.storagePath}`
        );
      }
    } else {
      const meta = manifest.emailMeta[key] ?? [];
      // eslint-disable-next-line no-console
      console.log(`  ${key}: (no xlsx found; ${meta.length} email(s) matched the query)`);
    }
  }
  // eslint-disable-next-line no-console
  console.log("\n=== RAW MANIFEST JSON ===");
  // Buffers are not in the manifest (only metadata) — safe to stringify.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(manifest, null, 2));
}

function defaultSince(): string {
  const d = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[mailclerk-live] ERROR:", err);
  process.exit(1);
});
