import Anthropic from '@anthropic-ai/sdk'

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

export const JARVIS_MODEL = 'claude-sonnet-4-6'
export const JARVIS_MAX_TOKENS = 4096

// ── Smart Held-Row Adjudicator · the investigator loop (P3) ──────────────────
// Sonnet is the default investigator (lookup work). Opus 4.8 is the CURRENT Opus,
// reserved for an explicit "escalate" — matching the project-wide "Opus-high for
// hard judgment, Sonnet for lookups" rule.
export const INVESTIGATOR_MODEL = 'claude-sonnet-4-6'
export const INVESTIGATOR_ESCALATION_MODEL = 'claude-opus-4-8'
export const INVESTIGATOR_MAX_TOKENS = 4096
