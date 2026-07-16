export type DeliveryRow = {
    transaction_date: string;
    batch_code: string;
    state?: string;
    block_loc: string;
    supplier: string;
    truck_plate: string;
    sacks: number;
    weight_kg: number;
    cost_basis?: number;
    remarks?: string;
    // Weight-deduction / true-weight annotation (display-only — see DEDUCTIONS_DESIGN.md).
    // Additive + nullable so existing DeliveryRow/edit-shape construction is unaffected.
    true_weight_kg?: number | null;
    deduction_note?: string | null;
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
        status: string;
    };
};

export type AuditLogRow = {
    id: string;
    record_id: string;
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    diff: Record<string, { old: unknown; new: unknown }> | null;
    snapshot: Record<string, unknown> | null;
    performed_by: string | null;
    performed_at: string;
    comment?: string | null;
    resolved: boolean;
    resolved_by: string | null;
    resolved_at: string | null;
    resolve_requested: boolean;
    resolve_request_type: 'resolve' | 'reopen' | null;
    resolve_requested_by: string | null;
    resolve_requested_at: string | null;
    profiles?: {
        display_name: string | null;
        email: string;
        avatar_url: string | null;
    } | null;
};

export type AuditComment = {
    id: string;
    audit_log_id: string;
    user_id: string;
    body: string;
    resolved: boolean;
    resolved_by: string | null;
    resolved_at: string | null;
    created_at: string;
    profiles?: {
        display_name: string | null;
        email: string;
        avatar_url: string | null;
    } | null;
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
