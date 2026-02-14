export type RcOutRow = {
    id: string;
    transaction_date: string;
    batch_id: string;
    production_batch: string; // The "BATCH" column (e.g., OCTOBER)
    destination: string;      // PLANT/ETC
    weight_kg: number;
    remarks?: string;
    block_loc: string;       // Physical location snapshot

    // Computed Columns
    avg_price: number;
    avg_wtd_value: number;

    // Joined Fields
    batches?: {
        batch_code: string;
    };

    created_at: string;
};

export type RcOutInput = {
    transaction_date: string;
    production_batch: string;
    destination: string;
    weight_kg: number;
    remarks: string;
    block_loc: string;
    batch_id: string; // User selects Block -> we store ID
};
