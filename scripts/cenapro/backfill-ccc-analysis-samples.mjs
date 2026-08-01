#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Cenapro CCC/QC analysis — one-shot, RE-RUNNABLE backfill of the 500 lab
// samples transcribed from Renzo's CCC-CI ANALYSIS sheet into
// `cenapro.analysis_sample`.
//
//   node scripts/cenapro/backfill-ccc-analysis-samples.mjs [--dry-run]
//
// SOURCE  lib/cenapro/ccc-analysis-fixture.json — keyed "YYYY-MM-DD|SRC|WHSE"
//         → {bd, ash, grit, mc}, any metric nullable.
// TARGET  public.cenapro_import_analysis_samples(jsonb)  (service_role only).
//
// WHY ALL 500 AND NOT JUST THE 383 THAT MATCH AN EVENT TODAY
// They are real lab readings. The ~117 that place nowhere are almost all
// pre-June DVO samples describing container-van weights the DB does not carry
// yet (DVO was deferred out of Cenapro v1 and the events view only holds DVO
// from 2026-06). Dropping them would mean re-transcribing the sheet the day DVO
// is backfilled. Stored, they cost nothing — the analysis views join FROM event
// groups, so an unplaced sample is simply invisible until its weights arrive.
//
// KEY RESOLUTION (three rules, applied in order)
//   1. EXACT — the sheet's (date, SRC, WHSE) is an event group. Import as-is.
//      The join key is coalesce(warehouse_code, plant_code): FLEC/DVO rows put
//      the warehouse there, tank/W7 rows put the plant there.
//   2. SINGLE-CANDIDATE REMAP — the sheet key hits no group, but that (date,
//      SRC) has exactly ONE event group and that group has no sample of its own.
//      The reading unambiguously describes that draw, so the sheet's warehouse
//      label is corrected to the DB's. The original sheet key is preserved in
//      `notes`. Exactly ONE row qualifies today: 2025-12-02|FLEC|WHSE 5, whose
//      only Dec-2 FLEC draw is recorded under WHSE 7.
//   3. ORPHAN — anything else keeps its raw sheet key.
//
// DELIBERATE DIVERGENCE FROM THE DRAFT'S MATCHER
// The evaluation-era `lib/cenapro/ccc-analysis-draft.ts` (deleted 2026-08-01 when
// the QC routes cut over to the SQL views) had a `date|src` fallback that lends
// an ALREADY-PLACED sample to a second group. It fires once: on 2026-02-22 the
// FLEC|WHSE 7 sample is also shown against the FLEC|WHSE 5 group (2,249 kg,
// 0.17% of February). That is a fixture-matching heuristic, not a fact — the
// sheet never sampled that draw. Rule 2 deliberately refuses it: guessing a lab
// value onto an unsampled group would inflate coverage and pull a weighted
// average toward a number nobody measured. February coverage therefore reads
// 98.99% here vs 99.2% in the draft. No other month moves; May — the regression
// month — is untouched.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_PATH = path.join(ROOT, 'lib', 'cenapro', 'ccc-analysis-fixture.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ── env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
    const env = { ...process.env };
    const file = path.join(ROOT, '.env.local');
    if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#') || !t.includes('=')) continue;
            const i = t.indexOf('=');
            const k = t.slice(0, i).trim();
            if (!env[k]) env[k] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
        }
    }
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    }
    return env;
}

const env = loadEnv();

async function rest(pathname, init = {}) {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${pathname}`, {
        ...init,
        headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`REST ${res.status} on ${pathname}: ${text.slice(0, 900)}`);
    return text ? JSON.parse(text) : null;
}

/** The JS twin of cenapro.fn_canon_token(). */
const canon = (v) => (v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

// ── 1. read the sheet fixture ────────────────────────────────────────────────
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const sheetRows = [];
for (const [rawKey, value] of Object.entries(fixture)) {
    const [date, src, whse] = rawKey.split('|');
    if (!date || !src || !whse) {
        console.warn(`  ! skipping malformed fixture key "${rawKey}"`);
        continue;
    }
    sheetRows.push({
        rawKey,
        sample_date: date,
        source_location_code: canon(src),
        whse_key: canon(whse),
        bd: value.bd ?? null,
        ash: value.ash ?? null,
        grit: value.grit ?? null,
        mc: value.mc ?? null,
    });
}
console.log(`fixture rows read: ${sheetRows.length}`);

// ── 2. read the live event groups (the target grain) ─────────────────────────
const groups = await rest(
    'cenapro_ccc_sample_groups?select=sample_date,source_location_code,whse_key,total_kg,sample_id&limit=5000',
);
console.log(`live partner-receipt event groups: ${groups.length}`);

const groupKeys = new Set(groups.map((g) => `${g.sample_date}|${g.source_location_code}|${g.whse_key}`));
const groupsByDateSrc = new Map();
for (const g of groups) {
    const k = `${g.sample_date}|${g.source_location_code}`;
    const bucket = groupsByDateSrc.get(k);
    if (bucket) bucket.push(g);
    else groupsByDateSrc.set(k, [g]);
}

// ── 3. resolve each sheet row to its final natural key ───────────────────────
const sheetKeysClaimed = new Set(
    sheetRows
        .map((r) => `${r.sample_date}|${r.source_location_code}|${r.whse_key}`)
        .filter((k) => groupKeys.has(k)),
);

const payload = [];
const stats = { exact: 0, remapped: 0, orphan: 0 };
const remapLog = [];

for (const r of sheetRows) {
    const key = `${r.sample_date}|${r.source_location_code}|${r.whse_key}`;
    let whseKey = r.whse_key;
    let notes = null;

    if (groupKeys.has(key)) {
        stats.exact += 1;
    } else {
        const candidates = groupsByDateSrc.get(`${r.sample_date}|${r.source_location_code}`) ?? [];
        const unclaimed = candidates.filter(
            (g) => !sheetKeysClaimed.has(`${g.sample_date}|${g.source_location_code}|${g.whse_key}`),
        );
        if (candidates.length === 1 && unclaimed.length === 1) {
            whseKey = unclaimed[0].whse_key;
            notes = `remapped from sheet key ${r.rawKey} (sole ${r.source_location_code} draw that day is under ${whseKey})`;
            stats.remapped += 1;
            remapLog.push(`${r.rawKey} -> ${r.sample_date}|${r.source_location_code}|${whseKey}`);
        } else {
            stats.orphan += 1;
        }
    }

    payload.push({
        sample_date: r.sample_date,
        source_location_code: r.source_location_code,
        whse_key: whseKey,
        bd: r.bd,
        ash: r.ash,
        grit: r.grit,
        mc: r.mc,
        notes,
    });
}

console.log(
    `resolution: exact=${stats.exact}  remapped=${stats.remapped}  orphan=${stats.orphan}  ` +
        `(placed on an event group = ${stats.exact + stats.remapped})`,
);
for (const line of remapLog) console.log(`  remap  ${line}`);

// ── 4. before / import / after ───────────────────────────────────────────────
async function count(query) {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${query}`, {
        method: 'HEAD',
        headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: 'count=exact',
            Range: '0-0',
        },
    });
    return Number((res.headers.get('content-range') ?? '/0').split('/')[1]);
}

const before = await count('cenapro_analysis_samples?select=id');
console.log(`\ncenapro.analysis_sample BEFORE: ${before}`);

if (DRY_RUN) {
    console.log('--dry-run: no write performed.');
    process.exit(0);
}

const result = await rest('rpc/cenapro_import_analysis_samples', {
    method: 'POST',
    body: JSON.stringify({ p_rows: payload }),
});
console.log('import result:', JSON.stringify(result));

const after = await count('cenapro_analysis_samples?select=id');
console.log(`cenapro.analysis_sample AFTER:  ${after}`);

// ── 5. verification ──────────────────────────────────────────────────────────
const joined = await count('cenapro_ccc_sample_groups?select=sample_date&is_sampled=eq.true');
const julyGroups = await count(
    'cenapro_ccc_sample_groups?select=sample_date&sample_date=gte.2026-07-01&sample_date=lt.2026-08-01',
);
const julySampled = await count(
    'cenapro_ccc_sample_groups?select=sample_date&sample_date=gte.2026-07-01&sample_date=lt.2026-08-01&is_sampled=eq.true',
);
console.log(`\nevent groups now carrying a sample: ${joined} / ${groups.length}`);
console.log(`July 2026: ${julyGroups} groups, ${julySampled} sampled  (expected 0 — the live gap this feature fills)`);
