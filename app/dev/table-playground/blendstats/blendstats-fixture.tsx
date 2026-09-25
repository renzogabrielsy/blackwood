'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The blend action bar's rig. See `page.tsx` for why it exists and how it is gated.
//
// Every figure below is a LITERAL made up from the size of the selection so a test can
// tell which selection a reply describes (n blocks → block_count n, balance n × 12,345).
// It is NOT the blend arithmetic and nothing in the app reads it.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

import { cn } from '@/lib/utils';
import { BlendActionBar, type BlendEditingContext } from '@/app/(app)/inventory/blocking/blend-action-bar';
import {
  BLEND_LIVE_STATS_WATCHDOG_MS,
  useBlendLiveStats,
  type BlendStatsFetcher,
} from '@/app/(app)/inventory/blocking/blend-live-stats';
import type { BlendProposal } from '@/app/(app)/inventory/blocking/actions';

const BLOCKS = ['A-1A', 'A-2A', 'A-3A', 'A-4A', 'A-5A', 'A-8A', 'A-9A'];
const LATENCY_MS = 300;
const SLOW_MS = 1500;
const RESOLVED_BOTH = { resolved: ['A-1A', 'A-2A'], unresolved: [], total: 2 };

function fakeBlend(locs: string[], canView: boolean): BlendProposal {
  const n = locs.length;
  const raw = 40 + n * 0.25;
  return {
    blocks: locs.map((l) => ({
      block_loc: l,
      batch_code: `FIX-${l}`,
      status: 'STORED',
      balance: 12_345,
      mc: 10,
      ash: 5,
      bd_astm: 0.4,
      bd_jis: 0.45,
      grit: 2,
      vm: 12,
      fc: 80,
      php_kg: canView ? raw : null,
    })),
    block_count: n,
    total_balance: n * 12_345,
    weighted: { mc: 10 + n * 0.5, ash: 5 + n * 0.1, bd_astm: 0.4 + n * 0.01, bd_jis: 0.45, grit: 2, vm: 12, fc: 80 },
    raw_price_per_kg: canView ? raw : null,
    production_loss_pct: 30,
    product_cost_per_kg: canView ? Number((raw * 1.3).toFixed(4)) : null,
    can_view_prices: canView,
  };
}

export function BlendStatsFixture() {
  const params = useSearchParams();
  const canViewPrices = params.get('prices') !== '0';
  const modify = params.get('modify') === '1';
  const slow = params.get('slow');
  const fail = params.get('fail');
  const hang = params.get('hang');
  const watchdogMs = Number(params.get('watchdog')) || BLEND_LIVE_STATS_WATCHDOG_MS;

  // `?modify=1` opens a Modify session on v2 of a 4-version proposal, baseline 2 blocks.
  // Seeded as INITIAL state (not from an effect), the way Modify seeds the real grid in
  // one event.
  const [blendMode, setBlendMode] = React.useState(modify);
  const [selection, setSelection] = React.useState<Set<string>>(() =>
    modify ? new Set(['A-1A', 'A-2A']) : new Set(),
  );
  const [log, setLog] = React.useState<string[]>([]);
  const [calls, setCalls] = React.useState(0);
  const [editing, setEditing] = React.useState<BlendEditingContext | null>(() =>
    modify
      ? {
          proposalId: '00000000-0000-4000-8000-000000000001',
          title: 'Fixture proposal',
          notes: null,
          expectedVersionNo: 4,
          fromVersionNo: 2,
          fromRevisionNo: 1,
          baseline: fakeBlend(['A-1A', 'A-2A'], canViewPrices),
          resolution: RESOLVED_BOTH,
        }
      : null,
  );

  const note = React.useCallback((line: string) => setLog((prev) => [...prev, line]), []);

  const fetcher: BlendStatsFetcher = React.useCallback(
    (locs: string[]) => {
      const sig = locs.join('|');
      setCalls((c) => c + 1);
      note(`request ${sig}`);
      return new Promise<BlendProposal>((resolve, reject) => {
        if (hang && locs.includes(hang)) return; // never answers
        const ms = slow && sig === slow ? SLOW_MS : LATENCY_MS;
        setTimeout(() => {
          if (fail && locs.includes(fail)) {
            note(`reject ${sig}`);
            reject(new Error(`fixture: ${fail} refused`));
            return;
          }
          note(`resolve ${sig}`);
          resolve(fakeBlend(locs, canViewPrices));
        }, ms);
      });
    },
    [slow, fail, hang, canViewPrices, note],
  );

  const stats = useBlendLiveStats({ enabled: blendMode, selection, fetcher, watchdogMs });

  const toggle = (loc: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(loc)) next.delete(loc);
      else next.add(loc);
      return next;
    });

  const save = (kind: string) => async (changeNote: string) => {
    note(`${kind} ${changeNote || '(no note)'}`);
    return true;
  };

  return (
    <div className="min-h-dvh bg-background text-foreground p-4 space-y-3 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          data-fixture-blend-toggle
          onClick={() =>
            setBlendMode((on) => {
              if (on) {
                setSelection(new Set());
                setEditing(null);
              }
              return !on;
            })
          }
          className={cn(
            'px-3 py-1 rounded-full border',
            blendMode ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          Blend {blendMode ? 'ON' : 'OFF'}
        </button>
        {BLOCKS.map((loc) => (
          <button
            key={loc}
            data-fixture-block={loc}
            onClick={() => blendMode && toggle(loc)}
            className={cn(
              'px-2 py-1 rounded border font-mono',
              selection.has(loc) ? 'border-primary bg-primary/10' : 'border-border',
            )}
          >
            {loc}
          </button>
        ))}
        <span className="font-mono text-muted-foreground" data-fixture-calls={calls}>
          fetcher calls: {calls}
        </span>
      </div>
      <pre data-fixture-log className="text-[10px] text-muted-foreground whitespace-pre-wrap">
        {log.join('\n')}
      </pre>

      {blendMode && (
        <BlendActionBar
          selectionSize={selection.size}
          stats={stats}
          canViewPrices={canViewPrices}
          editing={editing}
          editingNotice={null}
          saving={false}
          onBuild={() => note('build')}
          onClear={() => setSelection(new Set())}
          onCancelEditing={() => setEditing(null)}
          onSaveVersion={save('append')}
          onOverwriteVersion={save('overwrite')}
          onSaveAsNew={async ({ title }) => {
            note(`fork ${title}`);
            return true;
          }}
        />
      )}
    </div>
  );
}
