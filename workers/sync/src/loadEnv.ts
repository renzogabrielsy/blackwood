/**
 * loadEnv.ts — side-effect module: load `workers/sync/.env` into process.env for
 * LOCAL runs, BEFORE anything reads a credential.
 *
 * Import this FIRST in index.ts (ESM runs imports in order, so its side effect
 * completes before dbos.ts / the workflow modules read process.env).
 *
 * Prod-safe: on Fly the secrets are already in process.env and no `.env` file
 * exists, so this is a silent no-op there. Existing process.env values ALWAYS win
 * (Fly secrets / shell exports are never overwritten by the file).
 *
 * `../.env` resolves to `workers/sync/.env` from both `src/` (tsx) and the bundled
 * `dist/index.js` (dist sits one level under workers/sync).
 */
import { readFileSync } from "node:fs";

function loadEnvFile(): void {
  let text: string;
  try {
    text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return; // no .env (e.g. Fly) — secrets come from the real environment.
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip a single layer of surrounding quotes if present
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val; // never clobber real env
  }
}

loadEnvFile();
