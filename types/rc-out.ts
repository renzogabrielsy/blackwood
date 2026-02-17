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
        status: string;
        location_ref: string;
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

export type InputRcOutRow = {
    transaction_date: string;
    production_batch: string;
    batch_code: string;      // Display field — maps to batch_id on submit
    destination: string;
    weight_kg: number | string;
    block_loc: string;
    remarks: string;
};
