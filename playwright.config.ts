import { defineConfig, devices } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────────
// Playwright — the Blackwood Table's parity suite.
//
// `e2e/table/parity.spec.ts` drives the REAL grid through the dev playground
// (`/dev/table-playground`), which mounts it on an in-memory array. No login, no
// Supabase, no tenant module: the suite asserts the interaction contract itself, so it
// keeps meaning something when the first consumer migrates onto the module.
//
// `env -u ANTHROPIC_API_KEY` is not optional here — Claude Code's shell exports that
// variable as an empty string and Next refuses to override an already-set variable from
// `.env.local`, so a dev server started without the `-u` reads it as blank.
// ─────────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? 'line' : [['list']],
    timeout: 30_000,
    expect: { timeout: 7_000 },
    use: {
        baseURL: BASE_URL,
        trace: 'retain-on-failure',
        // The grid reads and writes the system clipboard for Ctrl+C / Ctrl+V.
        permissions: ['clipboard-read', 'clipboard-write'],
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: 'env -u ANTHROPIC_API_KEY npm run dev',
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
