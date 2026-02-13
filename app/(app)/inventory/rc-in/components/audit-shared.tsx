'use client';

import { cn } from '@/lib/utils';
import {
  getFieldLabel,
  isHiddenField,
  formatFieldValue,
  flattenLabResultsDiff,
} from '@/lib/field-labels';
import type { AuditLogRow } from '@/types/rc-in';

export function OperationBadge({ op }: { op: AuditLogRow['operation'] }) {
  const styles = {
    INSERT: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    UPDATE: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    DELETE: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  };
  return (
    <span className={cn('text-[10px] font-mono font-bold px-1.5 py-0.5 rounded', styles[op])}>
      {op}
    </span>
  );
}

export function DiffDisplay({ entry }: { entry: AuditLogRow }) {
  if (entry.operation === 'INSERT') {
    return <p className="text-xs text-muted-foreground italic">Record created</p>;
  }
  if (entry.operation === 'DELETE') {
    return <p className="text-xs text-muted-foreground italic">Record deleted</p>;
  }
  if (!entry.diff || Object.keys(entry.diff).length === 0) {
    return <p className="text-xs text-muted-foreground italic">No changes recorded</p>;
  }

  const rows: { label: string; oldVal: string; newVal: string }[] = [];

  for (const [key, change] of Object.entries(entry.diff)) {
    if (isHiddenField(key)) continue;

    if (key === 'lab_results') {
      const labDiffs = flattenLabResultsDiff(change.old, change.new);
      for (const ld of labDiffs) {
        rows.push({ label: ld.label, oldVal: ld.oldFormatted, newVal: ld.newFormatted });
      }
    } else {
      rows.push({
        label: getFieldLabel(key),
        oldVal: formatFieldValue(key, change.old),
        newVal: formatFieldValue(key, change.new),
      });
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline gap-2 text-xs">
          <span className="font-medium text-muted-foreground w-24 shrink-0">{r.label}</span>
          <span className="line-through text-red-500 dark:text-red-400 font-mono">{r.oldVal}</span>
          <span className="text-muted-foreground">&rarr;</span>
          <span className="text-green-600 dark:text-green-400 font-mono">{r.newVal}</span>
        </div>
      ))}
    </div>
  );
}

export function getUserInitials(profile: AuditLogRow['profiles']): string {
  if (!profile) return '?';
  if (profile.display_name) {
    return profile.display_name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return profile.email[0].toUpperCase();
}

export function getUserName(entry: AuditLogRow): string {
  if (!entry.profiles) return 'System Import';
  return entry.profiles.display_name || entry.profiles.email;
}
