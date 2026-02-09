
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// --- 1. Load Environment Variables from .env.local ---
function loadEnv() {
    try {
        const envPath = path.resolve(process.cwd(), '.env.local');
        if (fs.existsSync(envPath)) {
            const envConfig = fs.readFileSync(envPath, 'utf-8');
            envConfig.split('\n').forEach((line) => {
                const match = line.match(/^([^=]+)=(.*)$/);
                if (match) {
                    const key = match[1].trim();
                    const value = match[2].trim().replace(/^['"](.*)['"]$/, '$1'); // Remove quotes
                    process.env[key] = value;
                }
            });
            console.log('Loaded .env.local');
        } else {
            console.warn('No .env.local file found. Assuming environment variables are set.');
        }
    } catch (error) {
        console.error('Error loading .env.local:', error);
    }
}

loadEnv();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // OR SERVICE_ROLE_KEY if needed for bypass RLS

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase URL or Key in environment variables.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. CSV Parsing Helper ---
// Regex to handle quoted fields correctly: matches quoted string OR non-comma sequence
const CSV_REGEX = /(?:^|,)(?:"([^"]*(?:""[^"]*)*)"|([^",]*))/g;

function parseCSVLine(line: string): string[] {
    // Manual parser
    const result: string[] = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (inQuote) {
            if (char === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuote = false;
                }
            } else {
                current += char;
            }
        } else {
            if (char === '"') {
                inQuote = true;
            } else if (char === ',') {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }
    }
    result.push(current);
    return result;
}

// --- 3. Date Conversion ---
function excelDateToJSDate(serial: number): Date {
    // Excel base date is Dec 30, 1899 for Mac/Windows compatibility usually
    // 45491 -> July 2024 roughly.
    // (45491 - 25569) * 86400 * 1000 = Unix Timestamp
    return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

// --- 4. Main Script ---
async function seed() {
    const csvPath = path.resolve(process.cwd(), '260209_rc_in_samples.csv');
    console.log(`Reading CSV from ${csvPath}...`);

    const fileContent = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
    // Handle different line endings
    const lines = fileContent.split(/\r?\n/).filter(l => l.trim().length > 0);

    const headers = parseCSVLine(lines[0]);
    // Expected headers based on inspection:
    // STATE,WHSE,DATE,SUPPLIER,BLOCK,BLOCK LOC,TRK,WT,SKS,MC,GRIT,ASTM,JIS,VM,ASH,FC,REMARKS,PHP/KG,PHP TTL,...

    const colIndex = (name: string) => headers.indexOf(name);

    // Map headers to indices
    const IDX = {
        STATE: colIndex('STATE'),
        WHSE: colIndex('WHSE'),
        DATE: colIndex('DATE'),
        SUPPLIER: colIndex('SUPPLIER'),
        BLOCK: colIndex('BLOCK'),
        BLOCK_LOC: colIndex('BLOCK LOC'),
        TRK: colIndex('TRK'),
        WT: colIndex('WT'),
        SKS: colIndex('SKS'),
        MC: colIndex('MC'),
        GRIT: colIndex('GRIT'),
        ASTM: colIndex('ASTM'), // This maps to bd_astm
        JIS: colIndex('JIS'),   // This maps to bd_jis
        VM: colIndex('VM'),
        ASH: colIndex('ASH'),
        FC: colIndex('FC'),
        REMARKS: colIndex('REMARKS'),
        COST: colIndex('PHP/KG'),
    };

    console.log('Column Mappings:', IDX);

    const batchesToUpsert = new Map<string, { batch_code: string; location_ref: string; status: string }>();
    // Structure: batch_code -> Object

    const deliveriesToInsert = [];

    console.log(`Processing ${lines.length - 1} rows...`);

    for (let i = 1; i < lines.length; i++) {
        const rawLine = lines[i];
        const row = parseCSVLine(rawLine);

        // Skip completely empty rows
        if (row.length < 5 || !row[IDX.BLOCK]) continue;

        const block = row[IDX.BLOCK].trim();
        if (!block) continue; // Skip if no block code

        const dateSerial = parseFloat(row[IDX.DATE]);
        let transactionDate;

        if (!isNaN(dateSerial)) {
            transactionDate = excelDateToJSDate(dateSerial).toISOString();
        } else {
            // Fallback for potentially already formatted dates (though inspection showed serials)
            // If it's empty, use now? Or skip?
            // Check if row[IDX.DATE] is a string like "2024-..."
            if (row[IDX.DATE] && row[IDX.DATE].includes('-')) {
                transactionDate = new Date(row[IDX.DATE]).toISOString();
            } else {
                // console.warn(`Row ${i}: Invalid date ${row[IDX.DATE]}. Skipping.`);
                // continue; 
                // Actually user said 260209_rc_in_samples.csv has serials 45491.
                // If missing, maybe log warning but try to proceed? 
                // Without date, DB might reject if not nullable.
                console.warn(`Row ${i}: Invalid date '${row[IDX.DATE]}'. Skipping.`);
                continue;
            }
        }

        const state = row[IDX.STATE]?.trim() || 'STORED';
        const location = row[IDX.BLOCK_LOC]?.trim() || '';

        // BATCH PREP
        if (!batchesToUpsert.has(block)) {
            batchesToUpsert.set(block, {
                batch_code: block,
                location_ref: location,
                status: state
            });
        }

        // DELIVERY PREP
        const supplier = row[IDX.SUPPLIER]?.trim() || '';
        const truck = row[IDX.TRK]?.trim() || null;
        const wt = parseFloat(row[IDX.WT]?.replace(/,/g, '')) || 0;
        const sks = parseFloat(row[IDX.SKS]?.replace(/,/g, '')) || 0;

        // Lab Results
        const safeFloat = (val: string) => {
            if (!val) return 0;
            const n = parseFloat(val.replace(/,/g, ''));
            return isNaN(n) ? 0 : n;
        }

        const lab_results = {
            mc: safeFloat(row[IDX.MC]),
            ash: safeFloat(row[IDX.ASH]),
            bd_astm: safeFloat(row[IDX.ASTM]),
            bd_jis: safeFloat(row[IDX.JIS]),
            grit: safeFloat(row[IDX.GRIT]),
            vm: safeFloat(row[IDX.VM]),
            fc: safeFloat(row[IDX.FC]),
        };

        const cost = safeFloat(row[IDX.COST]);
        const remarks = row[IDX.REMARKS]?.trim() || '';

        deliveriesToInsert.push({
            transaction_date: transactionDate,
            supplier: supplier,
            batch_code: block,
            block_loc: location, // duplicating here as per schema usually wants snapshot
            truck_plate: truck,
            sacks: sks,
            weight_kg: wt,
            cost_basis: cost,
            remarks: remarks,
            lab_results: lab_results
        });
    }

    // --- EXECUTE BATCH UPSERTS ---
    console.log(`Upserting ${batchesToUpsert.size} unique batches...`);
    const batchArray = Array.from(batchesToUpsert.values());

    // Supabase upsert
    const { error: batchError } = await supabase
        .from('batches')
        .upsert(batchArray, { onConflict: 'batch_code', ignoreDuplicates: true }); // Strategy: If exists, keep existing? User said "If NO, insert it". So ignoreDuplicates: true matches that.

    if (batchError) {
        console.error('Error inserting batches:', batchError);
        process.exit(1);
    } else {
        console.log('Batches validated/inserted.');
    }

    // --- EXECUTE DELIVERY INSERTS ---
    console.log(`Inserting ${deliveriesToInsert.length} deliveries...`);

    // Chunking inserts just in case (Supabase limit is usually generous but safe to chunk)
    const CHUNK_SIZE = 100;
    for (let i = 0; i < deliveriesToInsert.length; i += CHUNK_SIZE) {
        const chunk = deliveriesToInsert.slice(i, i + CHUNK_SIZE);
        const { error: deliveryError } = await supabase
            .from('deliveries')
            .insert(chunk);

        if (deliveryError) {
            console.error(`Error inserting chunk ${i / CHUNK_SIZE}:`, deliveryError);
        } else {
            console.log(`Inserted rows ${i} to ${i + chunk.length}`);
        }
    }

    console.log('Seeding complete.');
}

seed().catch(err => {
    console.error(err);
    process.exit(1);
});
