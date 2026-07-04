// esbuild bundler for the Blackwood sync worker.
// Produces a single Node ESM bundle in dist/. DBOS, supabase-js, imapflow,
// exceljs and mailparser are left EXTERNAL (they ship native/optional deps and
// dynamic requires that don't survive bundling) — they are installed in the
// runtime image's node_modules instead. See Dockerfile.
import { build } from "esbuild";

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
  banner: {
    // ESM interop shim so external CJS deps that call require() still work.
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});

console.log("[esbuild] dist/index.js built");
