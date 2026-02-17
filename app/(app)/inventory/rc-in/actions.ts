'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { DeliveryRow, AuditLogRow, AuditComment } from '@/types/rc-in';

import { getUserRole } from '@/lib/auth';
import { UserRole, PRIVILEGED_ROLES } from '@/types/auth';
import { validateBlockLoc, normalizeBlockLoc } from '@/lib/validation';

export type { DeliveryRow, AuditLogRow, AuditComment } from '@/types/rc-in';

/** Translates raw DB constraint violation messages into user-friendly strings */
function translateDbError(message: string): string {
    if (message.includes('chk_block_loc_format')) {
        return 'Invalid block location format. Expected format: A-1A, D-20D, etc.';
    }
    if (message.includes('chk_location_ref_format')) {
        return 'Invalid location reference format on batch.';
    }
    if (message.includes('idx_unique_active_batch_per_location')) {
        return 'Another active batch already occupies this location.';
    }
    return message;
}

/** Deduplicates and upserts batches from delivery rows */
async function upsertBatchesFromRows(rows: DeliveryRow[]) {
    const supabase = await createClient();
    const batchUpserts = rows.map(row => ({
        batch_code: row.batch_code,
        location_ref: row.block_loc ? normalizeBlockLoc(row.block_loc) : '',
    }));

    const uniqueBatches = Array.from(
        new Map(batchUpserts.map(item => [item.batch_code, item])).values()
    );

    const { error } = await supabase
        .from('batches')
        .upsert(uniqueBatches, { onConflict: 'batch_code' });

    if (error) {
        throw new Error(`Batch Error: ${error.message}`);
    }
}

/** Strips `state` and casts numerics for the deliveries table */
function toDeliveryPayload(row: DeliveryRow) {
    const { state, ...deliveryData } = row;
    return {
        ...deliveryData,
        block_loc: row.block_loc ? normalizeBlockLoc(row.block_loc) : null,
        weight_kg: Number(row.weight_kg),
        sacks: Number(row.sacks),
        cost_basis: row.cost_basis === undefined || row.cost_basis === null ? 0 : Number(row.cost_basis),
        lab_results: row.lab_results,
    };
}

export async function submitBulkDeliveries(rows: DeliveryRow[]) {
    if (!rows || rows.length === 0) {
        return { success: false, message: 'No rows to submit' };
    }

    // --- Block location validation ---
    const validationErrors: string[] = [];

    // 1. Format validation for each row with a block_loc
    for (let i = 0; i < rows.length; i++) {
        const loc = rows[i].block_loc?.trim();
        if (!loc) continue;

        const result = validateBlockLoc(loc);
        if (!result.valid) {
            validationErrors.push(`Row ${i + 1}: ${result.error}`);
        }
    }

    // 2. Duplicate location check — only for rows with valid block_loc values
    const rowsWithValidLocs = rows
        .map((row, i) => ({ row, index: i }))
        .filter(({ row }) => {
            const loc = row.block_loc?.trim();
            if (!loc) return false;
            return validateBlockLoc(loc).valid;
        });

    if (rowsWithValidLocs.length > 0) {
        const supabaseCheck = await createClient();
        const uniqueLocs = [...new Set(rowsWithValidLocs.map(({ row }) => row.block_loc.trim().toUpperCase()))];

        // Query active batches at these locations
        const { data: activeBatches, error: checkError } = await supabaseCheck
            .from('deliveries')
            .select('block_loc, batch_code, batches!inner(status)')
            .in('block_loc', uniqueLocs)
            .in('batches.status', ['STORED', 'IN-USE']);

        if (checkError) {
            console.error('Error checking block location conflicts:', checkError);
            // Non-fatal: proceed without duplicate check rather than blocking submission
        } else if (activeBatches && activeBatches.length > 0) {
            // Build a map of location -> active batch codes (deduplicated)
            const locToBatches = new Map<string, Set<string>>();
            for (const record of activeBatches) {
                const loc = record.block_loc.toUpperCase();
                if (!locToBatches.has(loc)) {
                    locToBatches.set(loc, new Set());
                }
                locToBatches.get(loc)!.add(record.batch_code);
            }

            // Check each submitted row against existing occupants
            for (const { row, index } of rowsWithValidLocs) {
                const loc = row.block_loc.trim().toUpperCase();
                const existingBatches = locToBatches.get(loc);
                if (!existingBatches) continue;

                // Only flag if the existing batch is DIFFERENT from the one being submitted
                for (const existingBatch of existingBatches) {
                    if (existingBatch !== row.batch_code) {
                        validationErrors.push(
                            `Row ${index + 1}: Location ${loc} is occupied by batch ${existingBatch}`
                        );
                    }
                }
            }
        }
    }

    // 3. Return all validation errors at once
    if (validationErrors.length > 0) {
        return {
            success: false,
            message: `Block location validation failed:\n${validationErrors.join('\n')}`,
        };
    }

    try {
        await upsertBatchesFromRows(rows);

        const supabase = await createClient();
        const deliveriesPayload = rows.map(toDeliveryPayload);

        const { error: deliveryError } = await supabase
            .from('deliveries')
            .insert(deliveriesPayload);

        if (deliveryError) {
            console.error(`Error inserting deliveries: ${deliveryError.message}`);
            throw new Error(`Delivery Insert Error: ${deliveryError.message}`);
        }

        revalidatePath('/inventory');
        return { success: true };

    } catch (error: unknown) {
        console.error('Submit Transaction Failed:', error);
        const rawMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return { success: false, message: translateDbError(rawMessage) };
    }
}

export async function updateDelivery(id: string, data: Partial<DeliveryRow>) {
    // Bug fix: validate block_loc format on single-delivery updates
    if (data.block_loc) {
        const result = validateBlockLoc(data.block_loc);
        if (!result.valid) {
            return { success: false, message: result.error };
        }
        // Normalize to uppercase before persisting
        data = { ...data, block_loc: normalizeBlockLoc(data.block_loc) };
    }

    const supabase = await createClient();
    try {
        const { error } = await supabase
            .from('deliveries')
            .update(data)
            .eq('id', id);

        if (error) {
            console.error('Error updating delivery:', error);
            return { success: false, message: translateDbError(error.message) };
        }

        revalidatePath('/inventory');
        return { success: true };
    } catch (error: unknown) {
        console.error('Update Delivery Failed:', error);
        const rawMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return { success: false, message: translateDbError(rawMessage) };
    }
}

export async function bulkUpdateDeliveries(updates: { id: string; data: DeliveryRow; comment?: string }[]) {
    if (!updates || updates.length === 0) {
        return { success: false, message: 'No rows to update' };
    }

    // --- Block location validation (same rules as submitBulkDeliveries) ---
    const validationErrors: string[] = [];
    const rows = updates.map(u => u.data);

    for (let i = 0; i < rows.length; i++) {
        const loc = rows[i].block_loc?.trim();
        if (!loc) continue;
        const result = validateBlockLoc(loc);
        if (!result.valid) {
            validationErrors.push(`Row ${i + 1}: ${result.error}`);
        }
    }

    const rowsWithValidLocs = rows
        .map((row, i) => ({ row, index: i }))
        .filter(({ row }) => {
            const loc = row.block_loc?.trim();
            if (!loc) return false;
            return validateBlockLoc(loc).valid;
        });

    if (rowsWithValidLocs.length > 0) {
        const supabaseCheck = await createClient();
        const uniqueLocs = [...new Set(rowsWithValidLocs.map(({ row }) => normalizeBlockLoc(row.block_loc)))];

        const { data: activeBatches, error: checkError } = await supabaseCheck
            .from('deliveries')
            .select('block_loc, batch_code, batches!inner(status)')
            .in('block_loc', uniqueLocs)
            .in('batches.status', ['STORED', 'IN-USE']);

        if (!checkError && activeBatches && activeBatches.length > 0) {
            const locToBatches = new Map<string, Set<string>>();
            for (const record of activeBatches) {
                const loc = record.block_loc.toUpperCase();
                if (!locToBatches.has(loc)) locToBatches.set(loc, new Set());
                locToBatches.get(loc)!.add(record.batch_code);
            }

            for (const { row, index } of rowsWithValidLocs) {
                const loc = normalizeBlockLoc(row.block_loc);
                const existingBatches = locToBatches.get(loc);
                if (!existingBatches) continue;
                for (const existingBatch of existingBatches) {
                    if (existingBatch !== row.batch_code) {
                        validationErrors.push(
                            `Row ${index + 1}: Location ${loc} is occupied by batch ${existingBatch}`
                        );
                    }
                }
            }
        }
    }

    if (validationErrors.length > 0) {
        return {
            success: false,
            message: `Block location validation failed:\n${validationErrors.join('\n')}`,
        };
    }

    try {
        await upsertBatchesFromRows(rows);

        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        for (const { id, data, comment } of updates) {
            // Set audit comment if provided
            if (comment) {
                await supabase.rpc('set_audit_comment', { comment });
            } else {
                await supabase.rpc('set_audit_comment', { comment: null });
            }

            const payload = toDeliveryPayload(data);
            const { error } = await supabase
                .from('deliveries')
                .update(payload)
                .eq('id', id);

            if (error) {
                throw new Error(`Update Error (${id}): ${translateDbError(error.message)}`);
            }

            // Also post the edit remark as a discussion comment on the new audit log
            if (comment && user) {
                const { data: latestLog } = await supabase
                    .from('audit_logs')
                    .select('id')
                    .eq('record_id', id)
                    .order('performed_at', { ascending: false })
                    .limit(1)
                    .single();

                if (latestLog) {
                    await supabase
                        .from('audit_comments')
                        .insert({
                            audit_log_id: latestLog.id,
                            user_id: user.id,
                            body: comment,
                        });
                }
            }
        }

        revalidatePath('/inventory');
        return { success: true };
    } catch (error: unknown) {
        console.error('Bulk Update Failed:', error);
        const rawMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return { success: false, message: translateDbError(rawMessage) };
    }
}

export async function bulkDeleteDeliveries(ids: string[]) {
    if (!ids || ids.length === 0) {
        return { success: false, message: 'No IDs to delete' };
    }

    const supabase = await createClient();
    const { error } = await supabase
        .from('deliveries')
        .delete()
        .in('id', ids);

    if (error) {
        console.error('Error bulk deleting deliveries:', error);
        return { success: false, message: error.message };
    }

    revalidatePath('/inventory');
    return { success: true };
}

export async function getDeliveryHistory(deliveryId: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    let role: UserRole = 'Production';

    if (user) {
        role = await getUserRole(user.id);
    }

    const isProduction = role === 'Production';

    // 1. Fetch delivery and raw audit logs (no join)
    const [deliveryRes, logsRes] = await Promise.all([
        supabase
            .from('deliveries')
            .select('*')
            .eq('id', deliveryId)
            .single(),
        supabase
            .from('audit_logs')
            .select('*')
            .eq('record_id', deliveryId)
            .order('performed_at', { ascending: false }),
    ]);

    if (deliveryRes.error) {
        return { success: false as const, message: deliveryRes.error.message };
    }

    if (logsRes.error) {
        console.error('Error fetching audit logs:', logsRes.error);
        // Return empty history but successful delivery fetch
        return {
            success: true as const,
            current: deliveryRes.data,
            history: [],
        };
    }

    const logs = logsRes.data || [];

    // 2. Extract unique user IDs from logs
    const userIds = Array.from(new Set(logs.map(log => log.performed_by).filter(Boolean)));

    // 3. Fetch profiles for these users
    let profilesMap: Record<string, { display_name: string | null; email: string; avatar_url: string | null }> = {};
    if (userIds.length > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name, email, avatar_url')
            .in('id', userIds);

        if (profiles) {
            profilesMap = profiles.reduce((acc, p) => {
                acc[p.id] = p;
                return acc;
            }, {} as Record<string, { display_name: string | null; email: string; avatar_url: string | null }>);
        }
    }

    // 4. Attach profiles to logs
    // 4. Attach profiles to logs and scrub sensitive data if needed
    const historyWithProfiles: AuditLogRow[] = logs.map(log => {
        const enrichedLog = {
            ...log,
            profiles: profilesMap[log.performed_by] || { email: 'Unknown' }
        };

        if (isProduction) {
            // Scrub snapshot
            if (enrichedLog.snapshot && 'cost_basis' in enrichedLog.snapshot) {
                delete enrichedLog.snapshot['cost_basis'];
            }
            // Scrub diff
            if (enrichedLog.diff && 'cost_basis' in enrichedLog.diff) {
                delete enrichedLog.diff['cost_basis'];
            }
        }
        return enrichedLog;
    });

    const currentDelivery = deliveryRes.data;
    if (isProduction && currentDelivery) {
        // We can't delete property from typed object easily if it relies on return type inference 
        // but explicit cast or optional field helps.
        // However, generic Record<string, any> or just setting to undefined if optional.
        // The type definition says cost_basis is optional number now.
        currentDelivery.cost_basis = undefined;
    }

    return {
        success: true as const,
        current: currentDelivery,
        history: historyWithProfiles,
    };
}

export async function deleteDelivery(id: string) {
    const supabase = await createClient();
    const { error } = await supabase
        .from('deliveries')
        .delete()
        .eq('id', id);

    if (error) {
        console.error('Error deleting delivery:', error);
        return { success: false, message: error.message };
    }

    revalidatePath('/inventory');
    return { success: true };
}

export async function getAuditComments(auditLogId: string): Promise<AuditComment[]> {
    const supabase = await createClient();

    const { data: comments, error } = await supabase
        .from('audit_comments')
        .select('*')
        .eq('audit_log_id', auditLogId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('Error fetching audit comments:', error.message, error.code, error.details);
        return [];
    }

    if (!comments || comments.length === 0) return [];

    // Fetch profiles for comment authors
    const userIds = Array.from(new Set(comments.map(c => c.user_id).filter(Boolean)));
    let profilesMap: Record<string, { display_name: string | null; email: string; avatar_url: string | null }> = {};
    if (userIds.length > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name, email, avatar_url')
            .in('id', userIds);

        if (profiles) {
            profilesMap = profiles.reduce((acc, p) => {
                acc[p.id] = p;
                return acc;
            }, {} as Record<string, { display_name: string | null; email: string; avatar_url: string | null }>);
        }
    }

    return comments.map(c => ({
        ...c,
        profiles: profilesMap[c.user_id] || { email: 'Unknown' },
    }));
}

export async function addAuditComment(auditLogId: string, body: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return { success: false, message: 'Not authenticated' };
    }

    const { error } = await supabase
        .from('audit_comments')
        .insert({
            audit_log_id: auditLogId,
            user_id: user.id,
            body: body.trim(),
        });

    if (error) {
        console.error('Error adding audit comment:', error);
        return { success: false, message: error.message };
    }

    revalidatePath('/inventory');
    return { success: true };
}



export async function resolveAuditLog(auditLogId: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return { success: false, message: 'Not authenticated' };
    }

    // Only Admin/Owner/Dev can directly resolve
    const role = await getUserRole(user.id);
    if (!PRIVILEGED_ROLES.includes(role)) {
        return { success: false, message: 'Only Admin, Owner, or Dev can directly resolve edits' };
    }

    // Fetch current state to toggle
    const { data: log, error: fetchError } = await supabase
        .from('audit_logs')
        .select('resolved')
        .eq('id', auditLogId)
        .single();

    if (fetchError) {
        console.error('Error fetching audit log for resolve:', fetchError);
        return { success: false, message: fetchError.message };
    }

    const nowResolved = !log.resolved;
    const { error } = await supabase
        .from('audit_logs')
        .update({
            resolved: nowResolved,
            resolved_by: nowResolved ? user.id : null,
            resolved_at: nowResolved ? new Date().toISOString() : null,
        })
        .eq('id', auditLogId);

    if (error) {
        console.error('Error resolving audit log:', error);
        return { success: false, message: error.message };
    }

    // Log a system comment in the discussion
    await supabase
        .from('audit_comments')
        .insert({
            audit_log_id: auditLogId,
            user_id: user.id,
            body: nowResolved ? 'marked this edit as resolved' : 'reopened this edit',
        });

    revalidatePath('/inventory');
    revalidatePath(`/edit/${auditLogId}`);
    return { success: true, resolved: nowResolved };
}

export async function requestResolveAuditLog(auditLogId: string, type: 'resolve' | 'reopen') {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return { success: false, message: 'Not authenticated' };
    }

    const { error } = await supabase
        .from('audit_logs')
        .update({
            resolve_requested: true,
            resolve_request_type: type,
            resolve_requested_by: user.id,
            resolve_requested_at: new Date().toISOString(),
        })
        .eq('id', auditLogId);

    if (error) {
        console.error('Error requesting resolve:', error);
        return { success: false, message: error.message };
    }

    // Log system comment
    await supabase
        .from('audit_comments')
        .insert({
            audit_log_id: auditLogId,
            user_id: user.id,
            body: type === 'resolve'
                ? 'requested to resolve this edit'
                : 'requested to reopen this edit',
        });

    revalidatePath('/inventory');
    revalidatePath(`/edit/${auditLogId}`);
    return { success: true };
}

export async function approveResolveRequest(auditLogId: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return { success: false, message: 'Not authenticated' };
    }

    const role = await getUserRole(user.id);
    if (!PRIVILEGED_ROLES.includes(role)) {
        return { success: false, message: 'Only Admin, Owner, or Dev can approve requests' };
    }

    // Fetch the pending request
    const { data: log, error: fetchError } = await supabase
        .from('audit_logs')
        .select('resolve_requested, resolve_request_type, resolved')
        .eq('id', auditLogId)
        .single();

    if (fetchError) {
        return { success: false, message: fetchError.message };
    }

    if (!log.resolve_requested) {
        return { success: false, message: 'No pending request to approve' };
    }

    const nowResolved = log.resolve_request_type === 'resolve';
    const { error } = await supabase
        .from('audit_logs')
        .update({
            resolved: nowResolved,
            resolved_by: nowResolved ? user.id : null,
            resolved_at: nowResolved ? new Date().toISOString() : null,
            resolve_requested: false,
            resolve_request_type: null,
            resolve_requested_by: null,
            resolve_requested_at: null,
        })
        .eq('id', auditLogId);

    if (error) {
        return { success: false, message: error.message };
    }

    await supabase
        .from('audit_comments')
        .insert({
            audit_log_id: auditLogId,
            user_id: user.id,
            body: log.resolve_request_type === 'resolve'
                ? 'approved the resolve request'
                : 'approved the reopen request',
        });

    revalidatePath('/inventory');
    revalidatePath(`/edit/${auditLogId}`);
    return { success: true, resolved: nowResolved };
}

export async function denyResolveRequest(auditLogId: string, reason: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return { success: false, message: 'Not authenticated' };
    }

    const role = await getUserRole(user.id);
    if (!PRIVILEGED_ROLES.includes(role)) {
        return { success: false, message: 'Only Admin, Owner, or Dev can deny requests' };
    }

    // Fetch request type for the system message
    const { data: log, error: fetchError } = await supabase
        .from('audit_logs')
        .select('resolve_requested, resolve_request_type')
        .eq('id', auditLogId)
        .single();

    if (fetchError) {
        return { success: false, message: fetchError.message };
    }

    if (!log.resolve_requested) {
        return { success: false, message: 'No pending request to deny' };
    }

    const { error } = await supabase
        .from('audit_logs')
        .update({
            resolve_requested: false,
            resolve_request_type: null,
            resolve_requested_by: null,
            resolve_requested_at: null,
        })
        .eq('id', auditLogId);

    if (error) {
        return { success: false, message: error.message };
    }

    await supabase
        .from('audit_comments')
        .insert({
            audit_log_id: auditLogId,
            user_id: user.id,
            body: log.resolve_request_type === 'resolve'
                ? `denied the resolve request: ${reason.trim()}`
                : `denied the reopen request: ${reason.trim()}`,
        });

    revalidatePath('/inventory');
    revalidatePath(`/edit/${auditLogId}`);
    return { success: true };
}

export async function getAuditLogEntry(auditLogId: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    let role: UserRole = 'Production';
    if (user) {
        role = await getUserRole(user.id);
    }
    const isProduction = role === 'Production';

    const { data: log, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('id', auditLogId)
        .single();

    if (error) {
        return { success: false as const, message: error.message };
    }

    // Fetch profile for performed_by
    let profile = null;
    if (log.performed_by) {
        const { data } = await supabase
            .from('profiles')
            .select('id, display_name, email, avatar_url')
            .eq('id', log.performed_by)
            .single();
        profile = data;
    }

    // Fetch the delivery record if it exists
    let delivery = null;
    if (log.record_id) {
        const { data } = await supabase
            .from('deliveries')
            .select('*')
            .eq('id', log.record_id)
            .single();
        delivery = data;
    }

    if (isProduction) {
        if (log && log.snapshot && 'cost_basis' in log.snapshot) delete log.snapshot['cost_basis'];
        if (log && log.diff && 'cost_basis' in log.diff) delete log.diff['cost_basis'];
        if (delivery) delivery.cost_basis = undefined;
    }

    return {
        success: true as const,
        log: {
            ...log,
            profiles: profile || { email: 'Unknown' },
        } as AuditLogRow,
        delivery,
    };
}
