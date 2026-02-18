'use client';

import { cn } from '@/lib/utils';
import type { DensityMode } from '@/types/table-settings';

interface DensityToggleProps {
  value: DensityMode;
  onChange: (mode: DensityMode) => void;
}

const OPTIONS: { mode: DensityMode; label: string }[] = [
  { mode: 'normal', label: 'Normal' },
  { mode: 'expanded', label: 'Expanded' },
];

export function DensityToggle({ value, onChange }: DensityToggleProps) {
  return (
    <div className="bg-muted rounded-md p-0.5 flex items-center gap-0.5">
      {OPTIONS.map(({ mode, label }) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={cn(
            'px-3 py-1 rounded text-[11px] font-medium transition-all duration-200 cursor-pointer',
            value === mode
              ? 'bg-zinc-800 dark:bg-zinc-200 text-zinc-100 dark:text-zinc-900 shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
