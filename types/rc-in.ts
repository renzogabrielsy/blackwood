export type DeliveryRow = {
    transaction_date: string;
    batch_code: string;
    state?: string;
    block_loc: string;
    supplier: string;
    truck_plate: string;
    sacks: number;
    weight_kg: number;
    cost_basis: number;
    remarks?: string;
    lab_results: {
        mc: number;
        ash: number;
        bd_astm: number;
        bd_jis: number;
        grit: number;
        vm: number;
        fc: number;
    };
};

export type DeliveryHistoryRow = DeliveryRow & {
    id: string;
    created_at: string;
    batches?: {
        location_ref: string;
    };
};

export type InputDeliveryRow = {
    state: string;
    whse: string;
    transaction_date: string;
    supplier: string;
    batch_code: string;
    block_loc: string;
    truck_plate: string;
    weight_kg: number | string;
    sacks: number | string;
    mc: number | string;
    grit: number | string;
    bd_astm: number | string;
    bd_jis: number | string;
    vm: number | string;
    ash: number | string;
    fc: number | string;
    remarks: string;
    cost_basis: number | string;
};
