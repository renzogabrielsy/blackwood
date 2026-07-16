/**
 * Smoke test for Anthropic API setup.
 *
 * Verifies:
 *   1. ANTHROPIC_API_KEY is loaded from .env.local and works
 *   2. Access to claude-sonnet-4-6 (the default model for Jarvis)
 *   3. Access to claude-opus-4-7 (the escalation tier; 1M context is default on this model)
 *   4. The @anthropic-ai/sdk is wired up correctly
 *
 * Run with:  npx tsx scripts/test-anthropic.ts
 *
 * Notes on 1M context:
 *   - Per the latest Anthropic docs, both claude-opus-4-7 and claude-sonnet-4-6
 *     have 1M context windows BY DEFAULT — no header or param needed.
 *   - At standard API pricing (no long-context premium on Opus 4.7).
 *
 * Notes on Opus 4.7 quirks:
 *   - Sampling params (temperature, top_p, top_k) are removed — they return 400.
 *   - `budget_tokens` is removed — use `thinking: {type: "adaptive"}` instead.
 *   - Thinking text is omitted by default — set `thinking.display: "summarized"` to see it.
 *
 * Notes on prompt caching:
 *   - Minimum cacheable prefix on Opus 4.7 = 4096 tokens, on Sonnet 4.6 = 2048 tokens.
 *   - A 5-word smoke test is too small to actually hit the cache (silent no-op).
 *   - The script demonstrates the cache_control SYNTAX so we know the API accepts it;
 *     real cache hits will come when Jarvis has its full system prompt loaded.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

// --- Inline .env.local loader (no dotenv dependency) ---
function loadEnvLocal(): void {
  const envPath = join(process.cwd(), ".env.local");
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (err) {
    console.error(`✗ Could not read .env.local at ${envPath}`);
    throw err;
  }
}

loadEnvLocal();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("✗ ANTHROPIC_API_KEY is not set in .env.local");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY.startsWith("sk-ant-")) {
  console.error("✗ ANTHROPIC_API_KEY does not look like an Anthropic key (should start with 'sk-ant-')");
  process.exit(1);
}

const client = new Anthropic();
const TEST_PROMPT = "Reply in exactly 5 words. No punctuation. Just five words.";

type TestResult = {
  model: string;
  ok: boolean;
  response?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  error?: string;
};

async function testModel(opts: {
  model: string;
  label: string;
  useAdaptiveThinking?: boolean;
}): Promise<TestResult> {
  const start = Date.now();
  try {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: opts.model,
      max_tokens: 256,
      messages: [{ role: "user", content: TEST_PROMPT }],
    };

    if (opts.useAdaptiveThinking) {
      // Opus 4.7 supports adaptive thinking. display: "summarized" makes it visible.
      request.thinking = { type: "adaptive", display: "summarized" };
    }

    const response = await client.messages.create(request);
    const latencyMs = Date.now() - start;

    // Extract text content (response.content is a discriminated union)
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      }
    }

    return {
      model: opts.label,
      ok: true,
      response: text.trim(),
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      model: opts.label,
      ok: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function testCacheSyntax(): Promise<TestResult> {
  // Demonstrates cache_control syntax is accepted by the API.
  // Won't actually hit cache (prompt is too small) — that's expected.
  const start = Date.now();
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      system: [
        {
          type: "text",
          text: "You are a smoke test bot. Respond very briefly.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "Say OK" }],
    });

    const latencyMs = Date.now() - start;
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    return {
      model: "cache_control syntax check",
      ok: true,
      response: text.trim(),
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      model: "cache_control syntax check",
      ok: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printResult(r: TestResult): void {
  const mark = r.ok ? "✓" : "✗";
  console.log(`\n${mark} ${r.model}`);
  console.log(`  Latency: ${r.latencyMs}ms`);
  if (r.ok) {
    console.log(`  Response: ${JSON.stringify(r.response)}`);
    console.log(`  Tokens: ${r.inputTokens} in / ${r.outputTokens} out`);
    if (r.cacheCreationTokens) {
      console.log(`  Cache write: ${r.cacheCreationTokens} tokens (~1.25× cost)`);
    }
    if (r.cacheReadTokens) {
      console.log(`  Cache read: ${r.cacheReadTokens} tokens (~0.1× cost)`);
    }
  } else {
    console.log(`  Error: ${r.error}`);
  }
}

async function main(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Anthropic API Smoke Test");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Key: ${process.env.ANTHROPIC_API_KEY!.slice(0, 12)}…`);
  console.log(`  SDK: @anthropic-ai/sdk`);

  const results: TestResult[] = [];

  // Test 1: Sonnet 4.6 — the default Jarvis model
  console.log("\n[1/3] Calling claude-sonnet-4-6…");
  results.push(
    await testModel({
      model: "claude-sonnet-4-6",
      label: "claude-sonnet-4-6 (1M context, default model for Jarvis)",
    }),
  );

  // Test 2: Opus 4.7 — escalation tier with adaptive thinking
  console.log("\n[2/3] Calling claude-opus-4-7 with adaptive thinking…");
  results.push(
    await testModel({
      model: "claude-opus-4-7",
      label: "claude-opus-4-7 (1M context, escalation tier, adaptive thinking)",
      useAdaptiveThinking: true,
    }),
  );

  // Test 3: Cache control syntax check
  console.log("\n[3/3] Verifying cache_control syntax is accepted…");
  results.push(await testCacheSyntax());

  // --- Summary ---
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Results");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  results.forEach(printResult);

  const allOk = results.every((r) => r.ok);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (allOk) {
    console.log("  ✓ All checks passed. You're ready to build Jarvis.");
    console.log("");
    console.log("  Notes:");
    console.log("    - 1M context window is the default on both 4.7 and 4.6 models");
    console.log("    - No special header or param needed to access it");
    console.log("    - Prompt caching: minimum prefix is 4096 tokens on Opus 4.7,");
    console.log("      2048 on Sonnet 4.6 — real cache hits will land once Jarvis");
    console.log("      has its full system prompt + tools defined");
  } else {
    console.log("  ✗ Some checks failed. See errors above.");
    process.exit(1);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main().catch((err) => {
  console.error("\n✗ Smoke test crashed:");
  console.error(err);
  process.exit(1);
});
