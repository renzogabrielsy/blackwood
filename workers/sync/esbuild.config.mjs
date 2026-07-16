// esbuild bundler for the Blackwood sync worker.
// Produces a single Node ESM bundle in dist/. DBOS, supabase-js, imapflow,
// exceljs and mailparser are left EXTERNAL (they ship native/optional deps and
// dynamic requires that don't survive bundling) — they are installed in the
// runtime image's node_modules instead. See Dockerfile.
import { execSync } from "node:child_process";
import { build } from "esbuild";

// Build identity, inlined as string literals so a startup banner can prove
// "this process is running the code I think it's running" — guards against a
// stale compiled dist/ silently serving old code after a source-only edit.
let buildSha = "unknown";
try {
  buildSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  // Not a git checkout (e.g. some CI/image contexts) — fall back to "unknown".
}
const buildTime = new Date().toISOString();

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  sourcemap: true,
  // Keep runtime deps external — they are `npm ci --omit=dev`'d into the image.
  packages: "external",
  logLevel: "info",
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  banner: {
    // ESM interop shim so external CJS deps that call require() still work.
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});

console.log(`[esbuild] dist/index.js built (sha=${buildSha}, time=${buildTime})`);
