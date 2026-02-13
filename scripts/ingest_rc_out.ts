import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// Load env
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use Service Role

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials in .env.local');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const CSV_FILE = path.resolve(process.cwd(), '260213_rc_out_samples.csv');

// Excel Date Parser (Epoch: Dec 30 1899)
function parseExcelDate(serial: number): string {
    const utc_days = Math.floor(serial - 25569);
    const utc_value = utc_days * 86400;
    const date_info = new Date(utc_value * 1000);
    return date_info.toISOString().split('T')[0];
}

async function main() {
    console.log('Fetching Batches map...');
    const { data: batches, error: batchError } = await supabase
        .from('batches')
        .select('id, batch_code');

    if (batchError) {
        console.error('Error fetching batches:', batchError);
        return;
    }

    const batchMap = new Map(batches.map(b => [b.batch_code, b.id]));
    console.log(`Loaded ${batchMap.size} batches.`);

    const rows: any[] = [];

    fs.createReadStream(CSV_FILE)
        .pipe(csv({
            mapHeaders: ({ header }) => header.trim().replace(/^\ufeff/, '')
        }))
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            console.log(`Parsed ${rows.length} CSV rows. Starting ingestion...`);

            let successCount = 0;
            let errorCount = 0;
            let missingBatchCount = 0;

            for (const row of rows) {
                // Map Columns
                const blockName = row['BLOCK']; // e.g., "AUG-23-TNK2"
                const productionBatch = row['BATCH']; // e.g., "OCTOBER"
                const destination = row['PLANT/ETC']; // e.g., "MAIN"
                const weight = parseFloat(row['WT'].replace(/,/g, ''));
                const remarks = row['REMARKS'];
                const blockLoc = row['BLOCK LOC'];
                const avgPrice = row['AVG PRICE'] ? parseFloat(row['AVG PRICE'].replace(/,/g, '')) : null;
                const avgWtdValue = row['AVG WTD VALUE'] ? parseFloat(row['AVG WTD VALUE'].replace(/,/g, '')) : 0;

                let transactionDate = row['DATE'];

                if (!transactionDate) {
                    // console.error(`Missing DATE...`);
                    // errorCount++; 
                    continue; // Skip empty rows silently or log if needed
                }

                const transactionDateNum = Number(transactionDate);

                if (!isNaN(transactionDateNum)) {
                    // It is a number (Excel Serial)
                    transactionDate = parseExcelDate(transactionDateNum);
                } else if (isNaN(Date.parse(transactionDate))) {
                    console.error(`Invalid Date format for block ${blockName}: ${transactionDate}`);
                    errorCount++;
                    continue;
                }

                const batchId = batchMap.get(blockName);

                if (!batchId) {
                    // Special handling for "FEED" blocks or others
                    // console.warn(`Batch not found: ${blockName}`); 
                    missingBatchCount++;
                    continue;
                }

                const { error } = await supabase.from('rc_out').insert({
                    transaction_date: transactionDate,
                    batch_id: batchId,
                    production_batch: productionBatch,
                    destination: destination,
                    weight_kg: weight,
                    remarks: remarks,
                    block_loc: blockLoc,
                    avg_price: avgPrice, // This triggers the "Receipt" logic
                    avg_wtd_value: avgWtdValue
                });

                if (error) {
                    console.error(`Error inserting ${blockName}:`, error.message);
                    errorCount++;
                } else {
                    successCount++;
                }
            }

            console.log('--- Ingestion Complete ---');
            console.log(`Success: ${successCount}`);
            console.log(`Errors: ${errorCount}`);
            console.log(`Missing Batch references (Skipped): ${missingBatchCount}`);
            console.log('--------------------------');
        });
}

main();
