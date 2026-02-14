'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { DeliveryRow, AuditLogRow, AuditComment } from '@/types/rc-in';

import { getUserRole } from '@/lib/auth';
import { UserRole, PRIVILEGED_ROLES } from '@/types/auth';

export type { DeliveryRow, AuditLogRow, AuditComment } from '@/types/rc-in';

/** Deduplicates and upserts batches from delivery rows */
async function upsertBatchesFromRows(rows: DeliveryRow[]) {
    const supabase = await createClient();
    const batchUpserts = rows.map(row => ({
        batch_code: row.batch_code,
        status: row.state || 'STORED',
        location_ref: row.block_loc,
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

        revalidatePath('/inventory/rc-in');
        return { success: true };

    } catch (error: any) {
        console.error('Submit Transaction Failed:', error);
        return { success: false, message: error.message || 'Unknown error occurred' };
    }
}

export async function updateDelivery(id: string, data: Partial<DeliveryRow>) {
    const supabase = await createClient();
    const { error } = await supabase
        .from('deliveries')
        .update(data)
        .eq('id', id);

    if (error) {
        console.error('Error updating delivery:', error);
        return { success: false, message: error.message };
    }

    revalidatePath('/inventory/rc-in');
    return { success: true };
}

export async function bulkUpdateDeliveries(updates: { id: string; data: DeliveryRow; comment?: string }[]) {
    if (!updates || updates.length === 0) {
        return { success: false, message: 'No rows to update' };
    }

    try {
        const rows = updates.map(u => u.data);
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
                throw new Error(`Update Error (${id}): ${error.message}`);
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

        revalidatePath('/inventory/rc-in');
        return { success: true };
    } catch (error: any) {
        console.error('Bulk Update Failed:', error);
        return { success: false, message: error.message || 'Unknown error occurred' };
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

    revalidatePath('/inventory/rc-in');
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
    let profilesMap: Record<string, any> = {};
    if (userIds.length > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name, email, avatar_url')
            .in('id', userIds);

        if (profiles) {
            profilesMap = profiles.reduce((acc, p) => {
                acc[p.id] = p;
                return acc;
            }, {} as Record<string, any>);
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

    revalidatePath('/inventory/rc-in');
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
    let profilesMap: Record<string, any> = {};
    if (userIds.length > 0) {
        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name, email, avatar_url')
            .in('id', userIds);

        if (profiles) {
            profilesMap = profiles.reduce((acc, p) => {
                acc[p.id] = p;
                return acc;
            }, {} as Record<string, any>);
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

    revalidatePath('/inventory/rc-in');
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

    revalidatePath('/inventory/rc-in');
    revalidatePath(`/inventory/rc-in/edit/${auditLogId}`);
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

    revalidatePath('/inventory/rc-in');
    revalidatePath(`/inventory/rc-in/edit/${auditLogId}`);
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

    revalidatePath('/inventory/rc-in');
    revalidatePath(`/inventory/rc-in/edit/${auditLogId}`);
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

    revalidatePath('/inventory/rc-in');
    revalidatePath(`/inventory/rc-in/edit/${auditLogId}`);
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
