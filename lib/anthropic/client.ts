import Anthropic from '@anthropic-ai/sdk'

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

export const JARVIS_MODEL = 'claude-sonnet-4-6'
export const JARVIS_MAX_TOKENS = 4096
