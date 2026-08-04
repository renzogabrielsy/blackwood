#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Cenapro RC DELIVERIES — re-runnable import of the "RC 2026" tab of Cenapro's
// RC workbook into cenapro.rc_delivery / cenapro.rc_delivery_sample.
//
//   node scripts/cenapro/import-rc-deliveries.mjs [--dry-run] [--refresh]
//                                                [--input=PATH] [--sheet=NAME]
//
// SOURCE  scripts/cenapro/rc2026-extract.json — the parsed + validated extract:
//         { source, deliveries[], suppliers[], destinations[], flags[] }.
//         Committed alongside this script on purpose: it is the provenance
//         record for 991 rows of reference data, and re-parsing the .xlsx is
//         explicitly NOT part of this pipeline.
// TARGET  public.cenapro_rc_deliveries / _delivery_samples / _suppliers /
//         _destinations — the auto-updatable accessor views, service-role key.
//
// FLAGGED, NOT FIXED
// Every one of the 991 rows lands, including the ones the extractor could not
// fully resolve. Nothing is corrected on the way in:
//   * an unparseable date  -> delivery_date NULL + delivery_date_raw = "5/262026"
//   * an unmapped supplier -> supplier_code NULL, supplier_raw kept
//   * an unmapped yard     -> destination_code NULL, destination_raw kept
//   * a value that could not go in its column (a weight typed into the BD cell)
//     survives inside import_flags[].raw
//   * a suspected duplicate -> is_suspected_duplicate = true, row kept
// import_flags carries the extractor's full {kind, detail, raw} list per row.
//
// IDEMPOTENCY / RE-RUN SAFETY
// The natural key is (source_sheet, source_row), a real UNIQUE constraint, so a
// re-run upserts rather than duplicates. DEFAULT resolution is
// `ignore-duplicates`: an already-imported row is left ALONE, because by then a
// human may have resolved its flags in the app and this script must never undo
// that. Pass --refresh to switch to `merge-duplicates` and force the sheet's
// values back over the DB's — an explicit, destructive choice.
//
// THE GENERATED MONEY COLUMNS ARE NEVER SENT.
// net_weight_kg / price_php_kg / total_price_php / delivery_year are STORED
// GENERATED in the base table; the database computes them from gross weight,
// deduction, base price and adjustment. Sending one is an error, by design.
// `sheet_total_php` — the workbook's own printed TTL PRICE — IS sent, as an
// independent witness, and the verification below asserts the two agree on
// every row.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const argOf = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY_RUN = process.argv.includes('--dry-run');
const REFRESH = process.argv.includes('--refresh');
const INPUT = path.resolve(ROOT, argOf('input', path.join(HERE, 'rc2026-extract.json')));
const SHEET = argOf('sheet', 'RC 2026');
const CHUNK = 250;

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
    if (!res.ok) throw new Error(`REST ${res.status} on ${pathname}: ${text.slice(0, 1200)}`);
    return text ? JSON.parse(text) : null;
}

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

/** Upsert a batch through an auto-updatable accessor view. */
async function upsert(view, rows, onConflict, key = 'id') {
    const resolution = REFRESH ? 'merge-duplicates' : 'ignore-duplicates';
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const out = await rest(`${view}?on_conflict=${encodeURIComponent(onConflict)}&select=${key}`, {
            method: 'POST',
            headers: { Prefer: `resolution=${resolution},return=representation` },
            body: JSON.stringify(slice),
        });
        written += Array.isArray(out) ? out.length : 0;
        process.stdout.write(`  ${view}: ${Math.min(i + CHUNK, rows.length)}/${rows.length}\r`);
    }
    process.stdout.write('\n');
    return written;
}

// ── 1. read the extract ──────────────────────────────────────────────────────
const extract = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const deliveries = extract.deliveries ?? [];
const suppliers = extract.suppliers ?? [];
const destinations = extract.destinations ?? [];
const flags = extract.flags ?? [];

console.log(`source      : ${extract.source ?? '(unlabelled)'}`);
console.log(`input       : ${path.relative(ROOT, INPUT)}`);
console.log(`sheet label : ${SHEET}`);
console.log(`mode        : ${DRY_RUN ? 'DRY RUN' : REFRESH ? 'REFRESH (merge-duplicates)' : 'IMPORT (ignore-duplicates)'}`);
console.log(
    `read        : ${deliveries.length} deliveries, ` +
        `${deliveries.reduce((n, d) => n + (d.samples?.length ?? 0), 0)} samples, ` +
        `${suppliers.length} suppliers, ${destinations.length} destinations, ${flags.length} flags`,
);

// ── 2. flags, grouped by the row they describe ───────────────────────────────
const flagsByRow = new Map();
for (const f of flags) {
    const bucket = flagsByRow.get(f.source_row);
    const entry = { kind: f.kind, detail: f.detail ?? null, raw: f.raw ?? null };
    if (bucket) bucket.push(entry);
    else flagsByRow.set(f.source_row, [entry]);
}
const dateRawByRow = new Map(
    flags.filter((f) => f.kind === 'date_unparseable').map((f) => [f.source_row, String(f.raw ?? '')]),
);

// ── 3. dimensions ────────────────────────────────────────────────────────────
const supplierRows = suppliers.map((code, i) => ({
    code,
    display_name: code,
    sort_order: (i + 1) * 10,
}));
const destinationRows = destinations.map((d, i) => ({
    code: d.code,
    display_name: d.code,
    kind: d.kind,
    has_sides: Boolean(d.has_sides),
    sort_order: (i + 1) * 10,
}));

// ── 4. delivery payloads ─────────────────────────────────────────────────────
// Column order mirrors the sheet. The four generated columns are ABSENT.
const deliveryRows = deliveries.map((d) => {
    const rowFlags = flagsByRow.get(d.source_row) ?? [];
    const dateRaw = d.delivery_date ? null : (dateRawByRow.get(d.source_row) ?? null);
    if (!d.delivery_date && !dateRaw) {
        throw new Error(
            `row ${d.source_row}: no delivery_date and no date_unparseable flag to preserve — ` +
                `refusing to import a dateless row with nothing to show the operator.`,
        );
    }
    return {
        delivery_date: d.delivery_date ?? null,
        delivery_date_raw: dateRaw,
        truck_no: d.truck_no ?? null,
        supplier_code: d.supplier_code ?? null,
        supplier_origin: d.supplier_origin ?? null,
        permit_no: d.permit_no ?? null,
        supplier_raw: d.supplier_raw ?? null,
        sacks: d.sacks ?? null,
        gross_weight_kg: d.gross_weight_kg ?? null,
        deduction_pct: d.deduction_pct ?? null,
        weight_formula: d.weight_formula ?? null,
        bd: d.bd ?? null,
        moisture_pct: d.moisture_pct ?? null,
        grit: d.grit ?? null,
        ash: d.ash ?? null,
        dust: d.dust ?? null,
        vm: d.vm ?? null,
        fc: d.fc ?? null,
        destination_code: d.destination_code ?? null,
        destination_side: d.destination_side ?? null,
        destination_raw: d.destination_raw ?? null,
        remarks: d.remarks ?? null,
        base_price_php_kg: d.base_price_php_kg ?? null,
        price_adjustment_php_kg: d.price_adjustment_php_kg ?? null,
        price_formula: d.price_formula ?? null,
        provenance: 'sheet_import',
        source_sheet: SHEET,
        source_row: d.source_row,
        sheet_total_php: d.sheet_total_php ?? null,
        is_suspected_duplicate: Boolean(d.is_suspected_duplicate),
        import_flags: rowFlags,
    };
});

const flaggedCount = deliveryRows.filter((r) => r.import_flags.length > 0).length;
const dupCount = deliveryRows.filter((r) => r.is_suspected_duplicate).length;
const nullDate = deliveryRows.filter((r) => r.delivery_date === null).length;
console.log(
    `payload     : ${deliveryRows.length} deliveries — ${flaggedCount} carry import flags, ` +
        `${dupCount} suspected duplicates, ${nullDate} with an unparseable date`,
);

if (DRY_RUN) {
    console.log('\n--dry-run: nothing written. Sample payload row:');
    console.log(JSON.stringify(deliveryRows.find((r) => r.import_flags.length > 0), null, 2));
    process.exit(0);
}

// ── 5. write ─────────────────────────────────────────────────────────────────
const beforeDeliveries = await count('cenapro_rc_deliveries?select=id');
const beforeSamples = await count('cenapro_rc_delivery_samples?select=id');
console.log(`\nBEFORE      : ${beforeDeliveries} deliveries, ${beforeSamples} samples`);

console.log('writing dimensions…');
await upsert('cenapro_rc_suppliers', supplierRows, 'code', 'code');
await upsert('cenapro_rc_destinations', destinationRows, 'code', 'code');

console.log('writing deliveries…');
await upsert('cenapro_rc_deliveries', deliveryRows, 'source_sheet,source_row');

// The sample rows need their parent's uuid, so read the id <-> source_row map
// back rather than relying on what the upsert happened to return.
console.log('resolving delivery ids…');
const idMap = new Map();
for (let offset = 0; ; offset += 1000) {
    const page = await rest(
        `cenapro_rc_deliveries?select=id,source_row&source_sheet=eq.${encodeURIComponent(SHEET)}` +
            `&order=source_row.asc&offset=${offset}&limit=1000`,
    );
    for (const r of page) idMap.set(r.source_row, r.id);
    if (page.length < 1000) break;
}
console.log(`  ${idMap.size} ids resolved`);

const sampleRows = [];
for (const d of deliveries) {
    const deliveryId = idMap.get(d.source_row);
    if (!deliveryId) throw new Error(`row ${d.source_row}: delivery id missing after import`);
    for (const s of d.samples ?? []) {
        sampleRows.push({
            delivery_id: deliveryId,
            position: s.position,
            label: s.label ?? null,
            bd: s.bd ?? null,
            moisture_pct: s.moisture_pct ?? null,
            grit: s.grit ?? null,
            ash: s.ash ?? null,
            dust: s.dust ?? null,
            vm: s.vm ?? null,
            fc: s.fc ?? null,
            source_row: s.source_row ?? null,
        });
    }
}
console.log(`writing ${sampleRows.length} samples…`);
await upsert('cenapro_rc_delivery_samples', sampleRows, 'delivery_id,position');

const afterDeliveries = await count('cenapro_rc_deliveries?select=id');
const afterSamples = await count('cenapro_rc_delivery_samples?select=id');
console.log(`AFTER       : ${afterDeliveries} deliveries, ${afterSamples} samples`);

// ── 6. verification — the money identity is the one that matters ─────────────
// total_price_php is computed by the database from gross weight / deduction /
// base price / adjustment. sheet_total_php is what the workbook printed. If a
// single row disagrees, the generated expression or the numeric precision is
// wrong, and everything downstream (liquidation) would be wrong with it.
// PostgREST cannot filter one column against another, so the comparison is done
// in SQL by cenapro.view_rc_delivery.sheet_total_matches — never re-derived here
// in floating-point JavaScript.
console.log('\nverifying…');
const mismatches = await rest(
    'cenapro_rc_delivery_rows?select=source_row,gross_weight_kg,deduction_pct,base_price_php_kg,' +
        'price_adjustment_php_kg,total_price_php,sheet_total_php' +
        `&source_sheet=eq.${encodeURIComponent(SHEET)}&sheet_total_matches=is.false&limit=50`,
);
console.log(`  total_price_php vs sheet_total_php mismatches : ${mismatches.length}`);
for (const m of mismatches.slice(0, 10)) console.log('   !', JSON.stringify(m));

const flaggedInDb = await count(
    `cenapro_rc_deliveries?select=id&source_sheet=eq.${encodeURIComponent(SHEET)}&import_flags=neq.[]`,
);
const dupInDb = await count(
    `cenapro_rc_deliveries?select=id&source_sheet=eq.${encodeURIComponent(SHEET)}&is_suspected_duplicate=is.true`,
);
const dedInDb = await count(
    `cenapro_rc_deliveries?select=id&source_sheet=eq.${encodeURIComponent(SHEET)}&deduction_pct=not.is.null`,
);
const adjInDb = await count(
    `cenapro_rc_deliveries?select=id&source_sheet=eq.${encodeURIComponent(SHEET)}&price_adjustment_php_kg=not.is.null`,
);
const noDateInDb = await count(
    `cenapro_rc_deliveries?select=id&source_sheet=eq.${encodeURIComponent(SHEET)}&delivery_date=is.null`,
);
console.log(`  rows carrying import flags                    : ${flaggedInDb}`);
console.log(`  is_suspected_duplicate                        : ${dupInDb}   (expected 22)`);
console.log(`  deduction_pct IS NOT NULL                     : ${dedInDb}   (expected 142)`);
console.log(`  price_adjustment_php_kg IS NOT NULL           : ${adjInDb}   (expected 12)`);
console.log(`  delivery_date IS NULL (unparseable)           : ${noDateInDb}   (expected 2)`);

const ok =
    mismatches.length === 0 &&
    afterDeliveries >= deliveryRows.length &&
    afterSamples >= sampleRows.length;
console.log(`\n${ok ? 'OK' : 'FAILED'} — ${afterDeliveries} deliveries, ${afterSamples} samples in the database.`);
process.exit(ok ? 0 : 1);
