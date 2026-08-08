#!/usr/bin/env node
/**
 * verify-container-build.mjs — the gate that would have caught the 2026-08-08 deploy
 * failure.
 *
 * WHAT WENT WRONG. `src/reports/excel/findingsBridge.ts` imports the app's finding
 * flattener across the package boundary (`../../../../../lib/sync/findings`). Every local
 * gate — `tsc --noEmit`, `npm test`, `npm run parity`, `npm run lint`, and even
 * `npm run build` — resolves that path off the dev machine's disk, where the file plainly
 * exists. The container did not contain it, so `flyctl deploy` was the FIRST thing in the
 * pipeline to try resolving the import against the image's real file set, and it failed
 * there: `ERROR: Could not resolve "../../../../../lib/sync/findings"`. A full day of sync
 * fixes sat inert because the only gate that exercised container module resolution was the
 * deploy itself.
 *
 * WHAT THIS DOES. Reconstructs the builder stage's file set EXACTLY, in a temp dir, then
 * runs the worker's own `esbuild.config.mjs` against it. Crucially it does not hardcode
 * that file set — it PARSES `workers/sync/Dockerfile` (the builder stage's WORKDIR + COPY
 * instructions) and the repo-root `.dockerignore`, so the gate cannot drift from the thing
 * it is checking. Add a cross-package import without adding the COPY, or add the COPY
 * without un-ignoring the file, and this goes red locally in a couple of seconds.
 *
 * It is NOT a docker build. There is no Docker daemon on the dev machine (Fly builds
 * remotely), and a real image build would cost minutes and a network round trip. What
 * actually broke was *module resolution over a restricted file set*, and that is exactly
 * and only what this reproduces — cheap enough to run before every deploy.
 *
 * SCOPE / LIMITS (stated so nobody over-trusts it):
 *   - Only the FIRST build stage is materialised. `COPY --from=…` lines are skipped: they
 *     move already-built artifacts between stages and cannot fail on a missing source.
 *   - `RUN` is not executed. Dependency installation is stood in for by symlinking the
 *     real node_modules (esbuild keeps every runtime dep external anyway — see
 *     esbuild.config.mjs — so node_modules matters here only for running esbuild itself).
 *   - The COPY subset understood is the one this Dockerfile uses: shell + JSON forms,
 *     multiple sources into a trailing-slash destination, `*` globs, files and whole
 *     directories. An unsupported form is a hard error, never a silent skip.
 *
 * Run: `npm run verify:container-build` (from workers/sync).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(WORKER_DIR, "..", "..");
const DOCKERFILE = path.join(WORKER_DIR, "Dockerfile");
const DOCKERIGNORE = path.join(REPO_ROOT, ".dockerignore");

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`\n  FAIL  ${msg}`);
};

/* ------------------------------------------------------------------ Dockerfile parse */

/**
 * Reads the Dockerfile, joins backslash-continued lines, and returns the instructions of
 * the FIRST build stage only (everything up to the second FROM).
 */
function parseBuilderStage(text) {
  const logical = [];
  let acc = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!acc && /^\s*(#|$)/.test(line)) continue; // comment or blank
    if (/\\\s*$/.test(line)) {
      acc += line.replace(/\\\s*$/, " ");
      continue;
    }
    logical.push((acc + line).trim());
    acc = "";
  }
  if (acc.trim()) logical.push(acc.trim());

  const out = [];
  let stages = 0;
  for (const line of logical) {
    const verb = line.split(/\s+/)[0].toUpperCase();
    if (verb === "FROM") {
      stages += 1;
      if (stages > 1) break;
      continue;
    }
    out.push({ verb, line });
  }
  return out;
}

/** Splits a COPY's arguments, honouring both the shell form and the JSON-array form. */
function copyArgs(line) {
  const body = line.replace(/^COPY\s+/i, "").trim();
  const flagless = body.replace(/(^|\s)--[^\s]+/g, " ").trim();
  if (flagless.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(flagless);
    } catch {
      throw new Error(`COPY: unparseable JSON form: ${line}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`COPY: JSON form is not an array: ${line}`);
    return parsed.map(String);
  }
  if (/["']/.test(flagless)) {
    // Quoted shell form — not used today; refuse rather than mis-split it.
    throw new Error(`COPY: quoted shell form is not supported, use the JSON form: ${line}`);
  }
  return flagless.split(/\s+/).filter(Boolean);
}

/* --------------------------------------------------------------- .dockerignore engine */

/**
 * Compiles one .dockerignore pattern the way Docker does: `**` spans separators, `*` and
 * `?` do not, and everything else is literal (so the parentheses in `app/(app)` match
 * themselves).
 */
function compilePattern(raw) {
  const negated = raw.startsWith("!");
  const body = (negated ? raw.slice(1) : raw).trim().replace(/^\.?\//, "").replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "*" && body[i + 1] === "*") {
      re += ".*";
      i += 1;
      if (body[i + 1] === "/") i += 1; // `**/x` also matches a bare `x`
      continue;
    }
    if (body[i] === "*") {
      re += "[^/]*";
      continue;
    }
    if (body[i] === "?") {
      re += "[^/]";
      continue;
    }
    re += body[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { negated, body, re: new RegExp(`^${re}$`) };
}

function loadDockerignore() {
  if (!fs.existsSync(DOCKERIGNORE)) {
    fail(`.dockerignore missing at ${DOCKERIGNORE} — a repo-root context without one uploads the entire monorepo.`);
    return [];
  }
  return fs
    .readFileSync(DOCKERIGNORE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(compilePattern);
}

/**
 * True when Docker would EXCLUDE this context-relative path.
 *
 * Docker evaluates a path against every pattern, last match wins, and a directory's
 * verdict is inherited by its children unless a later pattern re-matches deeper. That is
 * reproduced here by walking each ancestor prefix shortest-first and letting a deeper
 * prefix's verdict override a shallower one — which is precisely the behaviour our
 * deny-all-then-allow file relies on.
 */
function isIgnored(relPath, patterns) {
  const segs = relPath.split("/");
  let excluded = false;
  for (let n = 1; n <= segs.length; n += 1) {
    const prefix = segs.slice(0, n).join("/");
    for (const p of patterns) {
      if (p.re.test(prefix)) excluded = !p.negated;
    }
  }
  return excluded;
}

/* ------------------------------------------------------------------------ materialise */

function copyFileTracked(absSrc, absDest, relSrc, patterns, stats) {
  if (isIgnored(relSrc, patterns)) {
    stats.ignored.push(relSrc);
    return;
  }
  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  fs.copyFileSync(absSrc, absDest);
  stats.copied.push(relSrc);
  stats.bytes += fs.statSync(absSrc).size;
}

function copyTree(absSrc, absDest, relSrc, patterns, stats) {
  if (isIgnored(relSrc, patterns)) {
    stats.ignored.push(`${relSrc}/`);
    return;
  }
  for (const entry of fs.readdirSync(absSrc, { withFileTypes: true })) {
    const childRel = `${relSrc}/${entry.name}`;
    const childSrc = path.join(absSrc, entry.name);
    const childDest = path.join(absDest, entry.name);
    if (entry.isDirectory()) copyTree(childSrc, childDest, childRel, patterns, stats);
    else if (entry.isFile()) copyFileTracked(childSrc, childDest, childRel, patterns, stats);
  }
}

/** Expands a `*`-glob COPY source against the context. */
function expandSource(src) {
  if (!src.includes("*")) return [src];
  const dir = path.posix.dirname(src);
  const base = path.posix.basename(src);
  const absDir = path.join(REPO_ROOT, dir === "." ? "" : dir);
  if (!fs.existsSync(absDir)) return [];
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return fs
    .readdirSync(absDir)
    .filter((n) => re.test(n))
    .map((n) => (dir === "." ? n : `${dir}/${n}`));
}

function main() {
  console.log("verify-container-build — reproducing the Fly builder stage's file set\n");

  const patterns = loadDockerignore();
  const instructions = parseBuilderStage(fs.readFileSync(DOCKERFILE, "utf8"));
  const copies = instructions.filter((i) => i.verb === "COPY");
  if (copies.length === 0) fail("no COPY instructions found in the builder stage — is the Dockerfile intact?");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bw-container-build-"));
  const stats = { copied: [], ignored: [], bytes: 0 };
  let workdir = "/";
  let workerImageDir = null;

  try {
    for (const { verb, line } of instructions) {
      if (verb === "WORKDIR") {
        const target = line.split(/\s+/)[1];
        workdir = target.startsWith("/") ? target : path.posix.join(workdir, target);
        continue;
      }
      if (verb !== "COPY") continue;
      if (/--from=/.test(line)) continue; // stage-to-stage, cannot fail on a missing source

      const args = copyArgs(line);
      if (args.length < 2) throw new Error(`COPY needs a source and a destination: ${line}`);
      const destRaw = args[args.length - 1];
      const sources = args.slice(0, -1);
      const destIsDir = destRaw.endsWith("/") || destRaw === "." || destRaw === "./";
      if (sources.length > 1 && !destIsDir) {
        throw new Error(`COPY with multiple sources needs a trailing-slash destination: ${line}`);
      }
      const destImage = destRaw.startsWith("/")
        ? path.posix.normalize(destRaw)
        : path.posix.normalize(path.posix.join(workdir, destRaw));

      for (const srcPattern of sources) {
        const matches = expandSource(srcPattern);
        if (matches.length === 0 && !srcPattern.includes("*")) {
          fail(`COPY source does not exist in the build context: ${srcPattern}  (${line})`);
          continue;
        }
        for (const rel of matches) {
          const abs = path.join(REPO_ROOT, rel);
          if (!fs.existsSync(abs)) continue;
          const st = fs.statSync(abs);
          // Docker semantics: a directory source copies its CONTENTS into the destination.
          const destAbs = st.isDirectory()
            ? path.join(tmpRoot, destImage)
            : path.join(tmpRoot, destImage, destIsDir ? path.posix.basename(rel) : "");
          if (st.isDirectory()) copyTree(abs, destAbs, rel, patterns, stats);
          else if (destIsDir) copyFileTracked(abs, destAbs, rel, patterns, stats);
          else copyFileTracked(abs, path.join(tmpRoot, destImage), rel, patterns, stats);
        }
      }
    }

    workerImageDir = path.join(tmpRoot, workdir);
    console.log(`  context root : ${REPO_ROOT}`);
    console.log(`  image WORKDIR: ${workdir}`);
    console.log(`  files copied : ${stats.copied.length} (${(stats.bytes / 1024).toFixed(0)} KB)`);
    if (stats.ignored.length > 0) {
      console.log(`  .dockerignore withheld ${stats.ignored.length} path(s) a COPY asked for:`);
      for (const p of stats.ignored.slice(0, 20)) console.log(`      - ${p}`);
      fail(
        "a COPY source is excluded by .dockerignore, so it will be MISSING in the image. " +
          "Un-ignore it (repo-root .dockerignore) or drop the COPY.",
      );
    }

    if (failures === 0) {
      if (!fs.existsSync(path.join(workerImageDir, "esbuild.config.mjs"))) {
        fail(`esbuild.config.mjs did not land in ${workdir} — nothing to build.`);
      } else {
        // Stand in for `npm ci`: esbuild keeps every runtime dep external, so the only
        // thing node_modules is needed for here is running esbuild itself.
        const realModules = path.join(WORKER_DIR, "node_modules");
        if (!fs.existsSync(realModules)) {
          fail("workers/sync/node_modules is missing — run `npm install` first.");
        } else {
          fs.symlinkSync(realModules, path.join(workerImageDir, "node_modules"), "dir");
          console.log("\n  running the worker's own esbuild against that file set…\n");
          try {
            const out = execFileSync("node", ["esbuild.config.mjs"], {
              cwd: workerImageDir,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, BUILD_SHA: "verify" },
            });
            process.stdout.write(
              out
                .split("\n")
                .map((l) => (l ? `    ${l}` : l))
                .join("\n"),
            );
            const bundle = path.join(workerImageDir, "dist", "index.js");
            if (!fs.existsSync(bundle)) fail("esbuild reported success but dist/index.js is absent.");
            else {
              const kb = fs.statSync(bundle).size / 1024;
              if (kb < 100) fail(`bundle is implausibly small (${kb.toFixed(0)} KB) — did the entrypoint resolve?`);
              else console.log(`\n    bundle: ${kb.toFixed(0)} KB`);
            }
          } catch (err) {
            const detail = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err);
            console.error(
              detail
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n"),
            );
            fail(
              "esbuild could NOT build from the container's file set. This is the exact failure " +
                "`flyctl deploy` hits. Most likely a source file imports something outside " +
                "workers/sync/ that no COPY brings into the image.",
            );
          }
        }
      }
    }
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nverify-container-build: ${failures} failure(s). The container build WILL fail.\n`);
    process.exit(1);
  }
  console.log("\nverify-container-build: OK — the container's file set builds.\n");
}

main();
