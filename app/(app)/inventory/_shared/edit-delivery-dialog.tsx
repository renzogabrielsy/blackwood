'use client';

import { useState, useEffect } from 'react';
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FullDeliveryRecord } from '../blocking/types';
import { fetchSingleDelivery } from '../blocking/actions';
import { bulkUpdateDeliveries } from '@/app/(app)/inventory/rc-in/actions';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EditDeliveryDialogProps {
  deliveryId: string | null;
  canViewPrices: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface FormState {
  transaction_date: string;
  supplier: string;
  batch_code: string;
  block_loc: string;
  truck_plate: string;
  sacks: string;
  weight_kg: string;
  cost_basis: string;
  remarks: string;
  mc: string;
  ash: string;
  bd_astm: string;
  bd_jis: string;
  grit: string;
  vm: string;
  fc: string;
}

function deliveryToForm(d: FullDeliveryRecord): FormState {
  return {
    transaction_date: d.transaction_date,
    supplier:         d.supplier,
    batch_code:       d.batch_code,
    block_loc:        d.block_loc ?? '',
    truck_plate:      d.truck_plate ?? '',
    sacks:            String(d.sacks),
    weight_kg:        String(d.weight_kg),
    // cost_basis is null when role-gated (Production); default to '' so the (hidden)
    // PHP/KG input neither crashes nor shows a stale/zero price.
    cost_basis:       d.cost_basis !== null ? String(d.cost_basis) : '',
    remarks:          d.remarks ?? '',
    mc:               String(d.lab_results.mc),
    ash:              String(d.lab_results.ash),
    bd_astm:          String(d.lab_results.bd_astm),
    bd_jis:           String(d.lab_results.bd_jis),
    grit:             String(d.lab_results.grit),
    vm:               String(d.lab_results.vm),
    fc:               String(d.lab_results.fc),
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function EditDeliveryDialog({
  deliveryId,
  canViewPrices,
  onClose,
  onSuccess,
}: EditDeliveryDialogProps) {
  const isOpen = deliveryId !== null;

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [labOpen, setLabOpen] = useState(false);

  // Fetch full delivery record when dialog opens
  useEffect(() => {
    if (!deliveryId) {
      setForm(null);
      setError(null);
      setLabOpen(false);
      return;
    }

    let mounted = true;
    setLoading(true);
    setError(null);

    fetchSingleDelivery(deliveryId).then((result) => {
      if (!mounted) return;
      setLoading(false);
      if (result.success) {
        setForm(deliveryToForm(result.delivery));
      } else {
        setError(result.message);
      }
    });

    return () => { mounted = false; };
  }, [deliveryId]);

  function updateField(field: keyof FormState, value: string) {
    if (!form) return;
    setForm({ ...form, [field]: value });
  }

  async function handleSave() {
    if (!form || !deliveryId) return;

    setSaving(true);
    setError(null);

    try {
      const result = await bulkUpdateDeliveries([
        {
          id: deliveryId,
          data: {
            transaction_date: form.transaction_date,
            supplier:         form.supplier,
            batch_code:       form.batch_code,
            block_loc:        form.block_loc,
            truck_plate:      form.truck_plate,
            sacks:            Number(form.sacks) || 0,
            weight_kg:        Number(form.weight_kg) || 0,
            cost_basis:       Number(form.cost_basis) || 0,
            remarks:          form.remarks || undefined,
            lab_results: {
              mc:      Number(form.mc) || 0,
              ash:     Number(form.ash) || 0,
              bd_astm: Number(form.bd_astm) || 0,
              bd_jis:  Number(form.bd_jis) || 0,
              grit:    Number(form.grit) || 0,
              vm:      Number(form.vm) || 0,
              fc:      Number(form.fc) || 0,
            },
          },
          comment: 'Edited from blocking detail panel',
        },
      ]);

      if (result.success) {
        onSuccess();
      } else {
        setError(result.message ?? 'Failed to save delivery');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[480px] max-h-[85dvh] overflow-y-auto animate-modal-enter">
        <DialogHeader>
          <DialogTitle className="text-sm">Edit Delivery</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Update delivery details. Changes are tracked in the audit log.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error && !form ? (
          <div className="text-center py-8 text-xs text-destructive">
            {error}
          </div>
        ) : form ? (
          <div className="flex flex-col gap-4">
            {/* ── Primary fields ── */}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Date" htmlFor="edit-date">
                <Input
                  id="edit-date"
                  type="date"
                  value={form.transaction_date}
                  onChange={(e) => updateField('transaction_date', e.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </FormField>
              <FormField label="Supplier" htmlFor="edit-supplier">
                <Input
                  id="edit-supplier"
                  value={form.supplier}
                  onChange={(e) => updateField('supplier', e.target.value)}
                  className="h-8 text-xs"
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Batch Code" htmlFor="edit-batch-code">
                <Input
                  id="edit-batch-code"
                  value={form.batch_code}
                  onChange={(e) => updateField('batch_code', e.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </FormField>
              <FormField label="Block Loc" htmlFor="edit-block-loc">
                <Input
                  id="edit-block-loc"
                  value={form.block_loc}
                  onChange={(e) => updateField('block_loc', e.target.value)}
                  className="h-8 text-xs font-mono uppercase"
                  placeholder="e.g. A-1A"
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Truck Plate" htmlFor="edit-truck-plate">
                <Input
                  id="edit-truck-plate"
                  value={form.truck_plate}
                  onChange={(e) => updateField('truck_plate', e.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </FormField>
              <FormField label="Sacks" htmlFor="edit-sacks">
                <Input
                  id="edit-sacks"
                  type="number"
                  value={form.sacks}
                  onChange={(e) => updateField('sacks', e.target.value)}
                  className="h-8 text-xs font-mono text-right"
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Weight (kg)" htmlFor="edit-weight">
                <Input
                  id="edit-weight"
                  type="number"
                  value={form.weight_kg}
                  onChange={(e) => updateField('weight_kg', e.target.value)}
                  className="h-8 text-xs font-mono text-right"
                />
              </FormField>
              {canViewPrices && (
                <FormField label="PHP/KG" htmlFor="edit-cost">
                  <Input
                    id="edit-cost"
                    type="number"
                    step="0.01"
                    value={form.cost_basis}
                    onChange={(e) => updateField('cost_basis', e.target.value)}
                    className="h-8 text-xs font-mono text-right"
                  />
                </FormField>
              )}
            </div>

            {/* ── Remarks ── */}
            <FormField label="Remarks" htmlFor="edit-remarks">
              <textarea
                id="edit-remarks"
                value={form.remarks}
                onChange={(e) => updateField('remarks', e.target.value)}
                className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-xs
                           text-foreground placeholder:text-muted-foreground resize-y min-h-[48px] max-h-[100px]
                           focus:outline-none focus:ring-1 focus:ring-ring dark:bg-input/30"
                placeholder="Optional remarks..."
                rows={2}
              />
            </FormField>

            {/* ── Lab Results (collapsible) ── */}
            <div className="border border-border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setLabOpen(!labOpen)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold
                           text-muted-foreground uppercase tracking-wider hover:bg-muted/50
                           transition-colors duration-150 cursor-pointer"
              >
                <span>Lab Results</span>
                {labOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
              {labOpen && (
                <div className="px-3 pb-3 pt-1 border-t border-border">
                  <div className="grid grid-cols-2 gap-3">
                    <LabField label="MC" value={form.mc} onChange={(v) => updateField('mc', v)} step="0.01" />
                    <LabField label="Ash" value={form.ash} onChange={(v) => updateField('ash', v)} step="0.01" />
                    <LabField label="BD ASTM" value={form.bd_astm} onChange={(v) => updateField('bd_astm', v)} step="0.001" />
                    <LabField label="BD JIS" value={form.bd_jis} onChange={(v) => updateField('bd_jis', v)} step="0.001" />
                    <LabField label="Grit" value={form.grit} onChange={(v) => updateField('grit', v)} step="0.01" />
                    <LabField label="VM" value={form.vm} onChange={(v) => updateField('vm', v)} step="0.01" />
                    <LabField label="FC" value={form.fc} onChange={(v) => updateField('fc', v)} step="0.01" />
                  </div>
                </div>
              )}
            </div>

            {/* ── Error display ── */}
            {error && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving} className="text-xs">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || loading || !form}
            className="text-xs"
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function FormField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className={cn('text-[11px] text-muted-foreground')}>
        {label}
      </Label>
      {children}
    </div>
  );
}

function LabField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-xs font-mono text-right"
      />
    </div>
  );
}
