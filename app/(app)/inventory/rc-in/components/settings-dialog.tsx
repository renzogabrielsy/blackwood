'use client';

import React from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { useTableSettings } from '@/components/providers/table-settings';
import { DensityToggle } from './density-toggle';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { LabMetric } from '@/types/table-settings';
import { DEFAULT_LAB_HIGHLIGHTS, LAB_METRICS_ORDERED, LAB_METRIC_FULL_NAMES, HIGHLIGHT_COLORS } from '@/types/table-settings';

/** Number input that uses local string state so users can freely clear/retype digits,
 *  persisting the parsed number only on blur or Enter. */
function SettingsNumberInput({
  value,
  onChange,
  step,
  className,
}: {
  value: number;
  onChange: (val: number) => void;
  step: string;
  className?: string;
}) {
  const [local, setLocal] = React.useState(String(value));

  // Sync when external value changes (e.g. Reset button)
  React.useEffect(() => {
    setLocal(String(value));
  }, [value]);

  return (
    <Input
      type="number"
      step={step}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const num = parseFloat(local);
        if (!isNaN(num)) {
          onChange(num);
        } else {
          setLocal(String(value)); // revert on invalid
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur(); // trigger onBlur to persist
        }
      }}
      className={className}
    />
  );
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, setDensity, setFontSize, setLabHighlightField, setLabHighlights, resetSettings, isSaving } = useTableSettings();
  const highlights = settings.labHighlights;

  const handleResetMetric = (metric: LabMetric) => {
    // Use bulk setter to avoid stale closure from multiple rapid setLabHighlightField calls
    const next = { ...highlights };
    next[metric] = { ...DEFAULT_LAB_HIGHLIGHTS[metric] };
    setLabHighlights(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80">
        <DialogHeader>
          <DialogTitle>Table Display Settings</DialogTitle>
          <DialogDescription>
            Configure display preferences and highlight thresholds. Changes apply in real-time.
            {isSaving && <span className="ml-2 text-muted-foreground">Saving...</span>}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[500px] overflow-y-auto -mx-2 px-2 space-y-6">
          {/* Display section */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Display
            </p>
            <div className="space-y-4">
              {/* Density */}
              <div className="flex items-center justify-between">
                <Label className="text-xs">Row Density</Label>
                <DensityToggle value={settings.densityMode} onChange={setDensity} />
              </div>
              {/* Font size */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Font Size</Label>
                  <span className="text-xs font-mono text-muted-foreground">{settings.fontSize}px</span>
                </div>
                <Slider
                  value={[settings.fontSize]}
                  onValueChange={([v]) => setFontSize(v)}
                  min={9}
                  max={14}
                  step={1}
                  className="w-full"
                />
              </div>
            </div>
          </div>

          {/* Lab highlights section */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Lab Value Highlights
            </p>
            <p className="text-[10px] text-muted-foreground mb-3">
              Values that exceed the limit are highlighted. Each metric has a fixed direction based on charcoal quality standards.
            </p>
            <div className="flex flex-col gap-2">
              {LAB_METRICS_ORDERED.map((metric) => {
                const spec = highlights[metric];
                const isBD = metric === 'bd_astm' || metric === 'bd_jis';
                const step = isBD ? '0.01' : '1';
                const isDefault =
                  spec.limit === DEFAULT_LAB_HIGHLIGHTS[metric].limit &&
                  spec.color === DEFAULT_LAB_HIGHLIGHTS[metric].color &&
                  spec.enabled === DEFAULT_LAB_HIGHLIGHTS[metric].enabled;

                return (
                  <div
                    key={metric}
                    className={cn(
                      'flex items-center gap-3 py-1.5 px-2 rounded-md border border-border/30',
                      !spec.enabled && 'opacity-50'
                    )}
                  >
                    <Checkbox
                      checked={spec.enabled}
                      onCheckedChange={(checked) => setLabHighlightField(metric, 'enabled', !!checked)}
                      aria-label={`Toggle ${LAB_METRIC_FULL_NAMES[metric]} highlighting`}
                      className="size-3.5"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-semibold">{LAB_METRIC_FULL_NAMES[metric]}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground w-10 text-right">{spec.direction}</span>
                    <SettingsNumberInput
                      value={spec.limit}
                      onChange={(val) => setLabHighlightField(metric, 'limit', val)}
                      step={step}
                      className="h-6 text-[11px] font-mono w-[60px] px-1.5"
                    />
                    {/* Color picker */}
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-border hover:bg-muted transition-colors duration-150 cursor-pointer"
                          aria-label={`Change ${LAB_METRIC_FULL_NAMES[metric]} highlight color`}
                        >
                          <span className={cn('w-2.5 h-2.5 rounded-full', HIGHLIGHT_COLORS.find(c => c.key === spec.color)?.dot)} />
                          <ChevronDown className="size-2.5 text-muted-foreground" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-auto p-2">
                        <div className="grid grid-cols-4 gap-1.5">
                          {HIGHLIGHT_COLORS.map(c => (
                            <button
                              key={c.key}
                              onClick={() => setLabHighlightField(metric, 'color', c.key)}
                              className={cn(
                                'flex items-center justify-center w-7 h-7 rounded-md border transition-all duration-150 cursor-pointer',
                                spec.color === c.key
                                  ? 'border-foreground ring-1 ring-foreground/20'
                                  : 'border-transparent hover:border-border'
                              )}
                              title={c.label}
                            >
                              <span className={cn('w-3.5 h-3.5 rounded-full', c.dot)} />
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {/* Per-metric reset */}
                    {!isDefault && (
                      <button
                        onClick={() => handleResetMetric(metric)}
                        className="text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer"
                        title="Reset to default"
                      >
                        <RotateCcw className="size-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => resetSettings()}>
            Reset to Defaults
          </Button>
          <Button size="sm" className="text-xs" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
