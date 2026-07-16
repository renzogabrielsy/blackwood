/**
 * db-connect-test.mjs — verify DBOS_DATABASE_URL actually connects.
 *
 * RUN THIS FROM YOUR OWN TERMINAL (Terminal.app), not through Claude, so it uses
 * your real network — not a sandboxed command runner:
 *
 *     cd /Users/renzosy/blackwood/workers/sync
 *     node scripts/db-connect-test.mjs
 *
 * It loads workers/sync/.env, tries the DBOS system-DB connection with a 20s
 * timeout, and tells you CONNECTED (with the user/db it reached) or the exact
 * error — WITHOUT ever printing your password.
 */
import { readFileSync } from "node:fs";

// load ../.env (never clobber real env)
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim();
}

const url = process.env.DBOS_DATABASE_URL;
if (!url) {
  console.error("✗ DBOS_DATABASE_URL is not set in workers/sync/.env");
  process.exit(1);
}
// show the shape only (host:port), never the password
const shape = url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:<password>@");
console.log("Testing:", shape);

const { Client } = await import("pg");
const client = new Client({ connectionString: url, connectionTimeoutMillis: 20000, ssl: { rejectUnauthorized: false } });
const started = Date.now();
try {
  await client.connect();
  const r = await client.query("select current_user, current_database(), version()");
  console.log(`\n✓ CONNECTED in ${Date.now() - started}ms`);
  console.log("   user:", r.rows[0].current_user);
  console.log("   db  :", r.rows[0].current_database);
  console.log("\nYour DBOS_DATABASE_URL is good — `npm run dev` will work.");
  await client.end();
  process.exit(0);
} catch (e) {
  console.log(`\n✗ FAILED after ${Date.now() - started}ms: [${e.code || "no-code"}] ${e.message}`);
  console.log("\nIf this says 'password authentication failed' → reset the DB password.");
  console.log("If this TIMES OUT from your own terminal too → the pooler URL/region is off;");
  console.log("re-copy it from Supabase → Connect → Session pooler.");
  process.exit(1);
}
