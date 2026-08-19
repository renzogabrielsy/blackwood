import Link from "next/link";
import { HandHelping } from "lucide-react";

import { getSyncNeedsYou } from "@/app/(app)/sync/needs-you";

/**
 * SyncNeedsYou — the dashboard's one-line hook into Sync Review.
 *
 * "3 need you" beside the sync band, linking straight to `/sync/cases?run=<id>`. It is the
 * PANEL'S OWN COUNT: `getSyncNeedsYou()` runs the same `flattenRunFindings` →
 * `countDecisionsNeedingYou` pair over the same acknowledgement ledger, so the badge can
 * never claim a different number than the screen it points at.
 *
 * RENDERS NOTHING when the count is zero, when the reader is not privileged, or when the
 * count could not be produced. A badge is a nudge, not a status light — an absent nudge
 * costs one click into the panel, while a fabricated one sends someone hunting for work
 * that is not there. The role gate lives server-side in `getSyncNeedsYou`, so a
 * non-privileged reader's browser never receives this markup at all.
 *
 * Server Component — no interactivity, one read, no client bundle.
 */
export async function SyncNeedsYou() {
  const needs = await getSyncNeedsYou();
  if (!needs.ok || needs.count === 0) return null;

  const href = needs.runId
    ? `/sync/cases?run=${encodeURIComponent(needs.runId)}`
    : "/sync/cases";

  return (
    <Link
      href={href}
      title={`${needs.count} decision${needs.count === 1 ? "" : "s"} from the last sync, covering ${needs.flags} flag${needs.flags === 1 ? "" : "s"}. Open Sync Review.`}
      className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/10 px-2.5 py-1 text-[11px] font-medium text-orange-700 transition-all duration-150 hover:bg-orange-500/20 dark:text-orange-400"
    >
      <HandHelping className="h-3.5 w-3.5" />
      <span className="font-mono tabular-nums">{needs.count}</span>
      need you
    </Link>
  );
}
