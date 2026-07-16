'use client'

import * as React from 'react'
import { AlertTriangle } from 'lucide-react'

import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { RowDecisionToggle, type RowDecision } from './RowDecisionToggle'
import { ConfidenceDot } from './ConfidenceDot'
import type { ClassifiedRow } from '@/app/(app)/review-queue/actions'

// ─── Column config — strict RC IN left-to-right order ──────────────────────

interface ColumnSpec {
    key: string
    label: string
    width: number
    align?: 'left' | 'right'
    numeric?: boolean
    decimals?: number
    /** Render value as a number if defined, otherwise as a plain string. */
    format?: (raw: unknown) => string
}

const COLUMNS: ColumnSpec[] = [
    { key: 'transaction_date', label: 'DATE', width: 90, align: 'left' },
    { key: 'supplier', label: 'SUPPLIER', width: 140, align: 'left' },
    { key: 'batch_code', label: 'BATCH', width: 90, align: 'left' },
    { key: 'block_loc', label: 'BLK', width: 60, align: 'left' },
    { key: 'truck_plate', label: 'TRUCK', width: 80, align: 'left' },
    { key: 'sacks', label: 'SACKS', width: 55, align: 'right', numeric: true },
    { key: 'weight_kg', label: 'WEIGHT', width: 75, align: 'right', numeric: true, decimals: 0 },
    { key: 'lab_results.mc', label: 'MC', width: 55, align: 'right', numeric: true, decimals: 2 },
    { key: 'lab_results.grit', label: 'GRIT', width: 55, align: 'right', numeric: true, decimals: 2 },
    { key: 'lab_results.vm', label: 'VM', width: 55, align: 'right', numeric: true, decimals: 2 },
    { key: 'lab_results.ash', label: 'ASH', width: 55, align: 'right', numeric: true, decimals: 2 },
    { key: 'lab_results.fc', label: 'FC', width: 55, align: 'right', numeric: true, decimals: 2 },
    { key: 'lab_results.bd_astm', label: 'BD ASTM', width: 65, align: 'right', numeric: true, decimals: 3 },
    { key: 'lab_results.bd_jis', label: 'BD JIS', width: 65, align: 'right', numeric: true, decimals: 3 },
    { key: 'cost_basis', label: 'PHP/KG', width: 80, align: 'right', numeric: true, decimals: 2 },
    { key: 'remarks', label: 'REMARKS', width: 180, align: 'left' },
]

const TOTAL_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0)
const STATUS_WIDTH = 110 // first sticky-ish status column
const DECISION_WIDTH = 240 // last column for the toggle (changed rows only)

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Read a nested path like 'lab_results.mc' from an object safely. */
function getByPath(obj: Record<string, unknown> | null | undefined, path: string): unknown {
    if (!obj) return undefined
    const parts = path.split('.')
    let cur: unknown = obj
    for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as object)) {
            cur = (cur as Record<string, unknown>)[p]
        } else {
            return undefined
        }
    }
    return cur
}

function formatCell(value: unknown, col: ColumnSpec): string {
    if (value === null || value === undefined || value === '') return ''
    if (col.format) return col.format(value)
    if (col.numeric) {
        const n = typeof value === 'number' ? value : Number(value)
        if (Number.isNaN(n)) return String(value)
        if (col.decimals !== undefined) {
            return n.toLocaleString('en-US', {
                minimumFractionDigits: col.decimals,
                maximumFractionDigits: col.decimals,
            })
        }
        return n.toLocaleString('en-US')
    }
    if (col.key === 'transaction_date' && typeof value === 'string') {
        return value.slice(0, 10) // yyyy-MM-dd
    }
    return String(value)
}

/** Cheap deep equality for diff values (covers strings, numbers, nulls). */
function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a == null && b == null) return true
    if (typeof a === 'number' && typeof b === 'number') {
        return Math.abs(a - b) < 1e-9
    }
    return String(a ?? '') === String(b ?? '')
}

// ─── Props ─────────────────────────────────────────────────────────────────

interface ClassifiedRowsTableProps {
    rows: ClassifiedRow[]
    decisions: Record<number, RowDecision>
    onDecisionChange: (index: number, next: RowDecision) => void
    disabled?: boolean
}

export function ClassifiedRowsTable({
    rows,
    decisions,
    onDecisionChange,
    disabled,
}: ClassifiedRowsTableProps) {
    if (rows.length === 0) {
        return (
            <div className="py-8 text-center text-xs text-muted-foreground">
                No new or changed rows. Nothing to approve.
            </div>
        )
    }

    return (
        <TooltipProvider delayDuration={200}>
            <div className="overflow-x-auto">
                <table
                    className="table-fixed border-collapse text-xs"
                    style={{ width: STATUS_WIDTH + TOTAL_WIDTH + DECISION_WIDTH }}
                >
                    <colgroup>
                        <col style={{ width: STATUS_WIDTH }} />
                        {COLUMNS.map((c) => (
                            <col key={c.key} style={{ width: c.width }} />
                        ))}
                        <col style={{ width: DECISION_WIDTH }} />
                    </colgroup>

                    <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur-sm">
                        <tr className="border-b border-border">
                            <th className="text-left text-[10px] uppercase tracking-wide text-muted-foreground font-medium px-2 py-1.5">
                                Status
                            </th>
                            {COLUMNS.map((c) => (
                                <th
                                    key={c.key}
                                    className={cn(
                                        'text-[10px] uppercase tracking-wide text-muted-foreground font-medium px-2 py-1.5',
                                        c.align === 'right' ? 'text-right' : 'text-left'
                                    )}
                                >
                                    {c.label}
                                </th>
                            ))}
                            <th className="text-left text-[10px] uppercase tracking-wide text-muted-foreground font-medium px-2 py-1.5">
                                Decision
                            </th>
                        </tr>
                    </thead>

                    <tbody>
                        {rows.map((row) => (
                            <ClassifiedRow
                                key={row.index}
                                row={row}
                                decision={decisions[row.index] ?? 'email_wins'}
                                onDecisionChange={(next) => onDecisionChange(row.index, next)}
                                disabled={disabled}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </TooltipProvider>
    )
}

// ─── Row ───────────────────────────────────────────────────────────────────

interface ClassifiedRowProps {
    row: ClassifiedRow
    decision: RowDecision
    onDecisionChange: (next: RowDecision) => void
    disabled?: boolean
}

function ClassifiedRow({
    row,
    decision,
    onDecisionChange,
    disabled,
}: ClassifiedRowProps) {
    const isNew = row.class === 'NEW'

    // Build a quick lookup of changed fields for VALUE_CHANGED rows so cell
    // rendering can branch in O(1).
    const diffMap = React.useMemo(() => {
        const m = new Map<string, { emailValue: unknown; dbValue: unknown }>()
        for (const d of row.diff ?? []) {
            m.set(d.field, { emailValue: d.emailValue, dbValue: d.dbValue })
        }
        return m
    }, [row.diff])

    const warnings = row.warnings ?? []
    const hasWarnings = warnings.length > 0

    return (
        <tr
            className={cn(
                'h-8 border-b border-border/60',
                'transition-all duration-150',
                isNew
                    ? 'bg-emerald-500/[0.04] hover:bg-emerald-500/[0.08]'
                    : 'bg-amber-500/[0.04] hover:bg-amber-500/[0.08]'
            )}
        >
            {/* Status cell */}
            <td className="px-2 py-1 align-middle">
                <div className="flex items-center gap-1.5">
                    <ConfidenceDot value={row.confidence} />
                    <span
                        className={cn(
                            'text-[10px] font-medium uppercase tracking-wide',
                            isNew
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : 'text-amber-700 dark:text-amber-300'
                        )}
                    >
                        {isNew ? 'New' : 'Changed'}
                    </span>
                    {hasWarnings && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <AlertTriangle className="h-3 w-3 text-amber-500" />
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-[280px]">
                                <ul className="text-xs space-y-0.5">
                                    {warnings.map((w, i) => (
                                        <li key={i}>{w}</li>
                                    ))}
                                </ul>
                            </TooltipContent>
                        </Tooltip>
                    )}
                </div>
            </td>

            {/* Data cells */}
            {COLUMNS.map((col) => {
                const emailRaw = getByPath(row.payload, col.key)
                const diff = diffMap.get(col.key)
                const changed = diff !== undefined && !sameValue(diff.emailValue, diff.dbValue)
                const dbRaw = diff?.dbValue

                return (
                    <td
                        key={col.key}
                        className={cn(
                            'px-2 py-1 align-middle truncate',
                            col.align === 'right' ? 'text-right' : 'text-left',
                            col.numeric && 'font-mono tabular-nums',
                            changed && 'border-l-2 border-amber-500/60 bg-amber-500/[0.08]'
                        )}
                        title={typeof emailRaw === 'string' ? emailRaw : undefined}
                    >
                        {changed ? (
                            <DiffCell
                                emailValue={formatCell(emailRaw, col)}
                                dbValue={formatCell(dbRaw, col)}
                                align={col.align}
                            />
                        ) : (
                            <span className={cn(emailRaw == null && 'text-muted-foreground/40')}>
                                {formatCell(emailRaw, col) || '—'}
                            </span>
                        )}
                    </td>
                )
            })}

            {/* Decision cell */}
            <td className="px-2 py-1 align-middle">
                {isNew ? (
                    <span className="text-[10px] text-muted-foreground italic">
                        Auto-insert on approve
                    </span>
                ) : (
                    <RowDecisionToggle
                        value={decision}
                        onChange={onDecisionChange}
                        disabled={disabled}
                    />
                )}
            </td>
        </tr>
    )
}

// ─── Diff cell ─────────────────────────────────────────────────────────────

interface DiffCellProps {
    emailValue: string
    dbValue: string
    align?: 'left' | 'right'
}

/**
 * Renders a changed cell with email value on top (bold) and DB value below
 * (struck-through, muted). Both visible — Excel-dense, glanceable.
 */
function DiffCell({ emailValue, dbValue, align }: DiffCellProps) {
    return (
        <div
            className={cn(
                'leading-[1.15] flex flex-col gap-0',
                align === 'right' ? 'items-end' : 'items-start'
            )}
        >
            <span className="font-semibold text-foreground truncate max-w-full">
                {emailValue || '—'}
            </span>
            <span className="text-[10px] text-muted-foreground/70 line-through truncate max-w-full">
                {dbValue || '—'}
            </span>
        </div>
    )
}
