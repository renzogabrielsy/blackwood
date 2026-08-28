import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Retired features kept for reference only (dashboard-v1, prod-schedule-v1).
    // Already excluded from `tsconfig.json`; ignoring them here too keeps their
    // now-dangling `@/...` imports and unused locals out of the lint report.
    "_archived/**",
  ]),
]);

export default eslintConfig;
