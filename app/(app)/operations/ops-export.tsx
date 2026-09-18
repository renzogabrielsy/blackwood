'use client';

// ═════════════════════════════════════════════════════════════════════════════════
// ops-export.tsx — the `Export` button beside `Print`.
//
// It downloads `/operations/export?campaigns=…` for EXACTLY the campaigns the page
// is currently showing, so the workbook and the screen can never describe different
// groups.
//
// WHY A FETCH AND NOT A LINK. A plain `<a download>` cannot see a failure: a 401,
// a 502 from the adapter or a builder error would render as a downloaded file
// containing an error message, or as nothing at all. Fetching the blob lets the
// route's plain-text body go straight into `errorToast()` — which, per the HARD
// RULE in CLAUDE.md, persists until dismissed and carries a Copy button.
//
// The filename comes from the response's `Content-Disposition` (`filename*`,
// RFC 5987) rather than being rebuilt here — one definition, in the route.
// ═════════════════════════════════════════════════════════════════════════════════

import * as React from 'react';
import { Download, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';

interface OpsExportControlProps {
  /** The campaign keys the payload was resolved for, in the page's own order. */
  campaignKeys: readonly string[];
  /** For the tooltip — `Q3 2026`, or the campaign labels joined. */
  groupLabel: string;
  className?: string;
}

/** `attachment; filename="…"; filename*=UTF-8''…` → the decoded name. */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : null;
}

export function OpsExportControl({ campaignKeys, groupLabel, className }: OpsExportControlProps) {
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const href = `/operations/export?campaigns=${encodeURIComponent(campaignKeys.join(','))}`;
      const res = await fetch(href, { cache: 'no-store' });
      if (!res.ok) {
        // The route answers in plain text precisely so this reads well in a toast.
        const body = (await res.text().catch(() => '')).trim();
        errorToast('Could not export the operations ledger', {
          description: body || `The server answered ${res.status} ${res.statusText}.`,
        });
        return;
      }
      const blob = await res.blob();
      const name = filenameFrom(res.headers.get('Content-Disposition')) ?? 'Blackwood Operations.xlsx';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next frame — Safari needs the object alive through the click.
      requestAnimationFrame(() => URL.revokeObjectURL(url));
    } catch (e) {
      errorToast('Could not export the operations ledger', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, campaignKeys]);

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      aria-busy={busy}
      title={`Download ${groupLabel} as an Excel workbook — the EOQ summary, one tab per campaign, the RC Movement matrices and a Checks tab. Every derived figure is a live formula.`}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress disabled:opacity-70',
        className,
      )}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Download className="size-3.5" />
      )}
      <span>Export</span>
    </button>
  );
}
