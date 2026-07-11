/**
 * config.ts — the single dormant/live switch for Sync Review's AI layer.
 *
 * Renzo's decision (2026-07-11): Sync Review must present flags BLUNTLY with
 * deterministic template text only — ZERO Claude API calls in the sync path. The
 * investigator/triage/case-chat/narration machinery (lib/investigator/*, the
 * adjudicator, `narrateSyncRun`) stays on disk exactly as-is — code + DB columns
 * intact — but goes DORMANT: no automatic trigger fires, and the AI-only UI
 * (Investigate/Re-investigate/Escalate buttons, case chat, the verdict card, the
 * "Investigated" status/filter) is hidden. AI diagnosis moves to a copy-paste-
 * markdown-into-Claude-Code workflow ("Copy for Claude" buttons, network-free).
 *
 * TO RESTORE: flip this ONE constant to `true`. No other code change needed —
 * every call site and every UI gate reads this flag.
 *
 * CLIENT/SERVER BOUNDARY (see CLAUDE.md "Client/server module boundary trap"):
 * this module is imported by BOTH client components (CasesClient.tsx,
 * CaseDetail.tsx, RunGroupedList.tsx, useSyncRun.ts) and server modules
 * (cases.ts, actions.ts). It must stay a plain constant with ZERO imports —
 * pulling in anything server-heavy here (e.g. the Anthropic SDK, the admin
 * client) would drag it into every client bundle that reads the flag and break
 * `npm run build`.
 */
export const SYNC_AI_REVIEW_ENABLED = false
