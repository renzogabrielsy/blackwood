'use client'

import * as React from 'react'
import { Copy, Inbox, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { errorToast } from '@/lib/toast'
import { serializeCasesForClaude, type SerializableCase } from '@/lib/sync/findings'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { ensureCasesForRun, getCaseWithMessages, investigateCase } from '@/app/(app)/sync/cases'
import { chatOnCase } from '@/app/(app)/sync/case-chat'
import {
  bulkDismissCases,
  cancelProposal,
  executeCreateBatch,
  executeDiffResolution,
  executeGroupResolution,
  executeResolution,
  proposeCreateBatch,
  proposePickSource,
  quickDismiss,
} from '@/app/(app)/sync/resolve'
import {
  findOpenGroupProposal,
  findOpenProposal,
  type ProposalScanRow,
} from '@/lib/investigator/resolution'
import { findOpenPickSourcePlan, type PickSourceScanRow } from '@/app/(app)/sync/diff-plan'
import {
  findOpenCreateBatchPlan,
  type CreateBatchPlan,
  type CreateBatchScanRow,
} from '@/lib/sync/create-batch-plan'
import type { RcOutSource } from '@/app/(app)/sync/types'

import { RunGroupedList, type CaseFilter, type RunListCase } from './RunGroupedList'
import { CaseDetail, type CaseDetailRow } from './CaseDetail'
import type { GroupMemberCase } from './GroupResolutionCard'
import { asSourceDiff, type OpenPickPlan } from './SourceDiffCard'
import type { ThreadMessage } from './CaseThread'
import { QuickDismissDialog } from './QuickDismissDialog'
import { groupCasesByRun, isBulkSelectable, preselectForRun } from './grouping'
import { asVerdict } from './labels'

/** A held-case row as it arrives on the wire (list + Realtime share this shape). */
export interface WireCase extends RunListCase {
  reason: string | null
  detail: string | null
}

interface CasesClientProps {
  initialCases: WireCase[]
  initialError: string | null
  /** The `?run=<runId>` deep-link target (preselect that run's triage / first case). */
  initialRunId: string | null
}

/** Normalize a raw sync_held_cases Realtime row into our WireCase shape. */
function toWireCase(raw: Record<string, unknown>, prev?: WireCase): WireCase {
  return {
    id: String(raw.id),
    report_type: String(raw.report_type ?? ''),
    kind: String(raw.kind ?? 'other'),
    natural_key: String(raw.natural_key ?? ''),
    reason: (raw.reason as string | null) ?? null,
    detail: (raw.detail as string | null) ?? null,
    row: raw.row ?? null,
    status: String(raw.status ?? 'open'),
    occurrence_count: Number(raw.occurrence_count ?? 1),
    last_run_id: (raw.last_run_id as string | null) ?? prev?.last_run_id ?? null,
    last_seen_at: String(raw.last_seen_at ?? new Date().toISOString()),
    created_at: (raw.created_at as string | null) ?? prev?.created_at ?? null,
    known_ruling_id: (raw.known_ruling_id as string | null) ?? null,
    // Realtime rows don't carry the joined ruling summary — preserve the prior one.
    known_ruling_summary: prev?.known_ruling_summary ?? null,
    verdict: raw.verdict ?? null,
  }
}

function toThreadMessage(raw: Record<string, unknown>): ThreadMessage {
  return {
    id: String(raw.id),
    role: (raw.role as ThreadMessage['role']) ?? 'system',
    content: String(raw.content ?? ''),
    tool_calls: raw.tool_calls ?? null,
    tool_results: raw.tool_results ?? null,
    position: Number(raw.position ?? 0),
  }
}

export function CasesClient({ initialCases, initialError, initialRunId }: CasesClientProps) {
  const [cases, setCases] = React.useState<WireCase[]>(initialCases)
  const [selectedId, setSelectedId] = React.useState<string | null>(initialCases[0]?.id ?? null)
  const [messages, setMessages] = React.useState<ThreadMessage[]>([])
  const [chatPending, setChatPending] = React.useState(false)
  const [filter, setFilter] = React.useState<CaseFilter>('all')
  const [showResolved, setShowResolved] = React.useState(false)
  const [resolvePending, setResolvePending] = React.useState(false)
  const [quickDismissOpen, setQuickDismissOpen] = React.useState(false)

  // Per-run active cluster filter (runId → the chip's case_ids, or null/absent).
  const [clusterFilter, setClusterFilter] = React.useState<Record<string, string[] | null>>({})
  // Multi-select for bulk dismiss.
  const [selectedForBulk, setSelectedForBulk] = React.useState<Set<string>>(new Set())
  const [bulkDismissOpen, setBulkDismissOpen] = React.useState(false)
  // The deep-link run to scroll into view (cleared once handled once).
  const [scrollToRunId, setScrollToRunId] = React.useState<string | null>(initialRunId)

  const selectedIdRef = React.useRef<string | null>(selectedId)
  React.useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  React.useEffect(() => {
    if (initialError) errorToast('Could not load review cases', { description: initialError })
  }, [initialError])

  // ── Deep link: on mount, ensure the run's cases exist, then preselect + scroll. ──
  const didDeepLink = React.useRef(false)
  React.useEffect(() => {
    if (didDeepLink.current || !initialRunId) return
    didDeepLink.current = true
    // Best-effort: fan the run out (idempotent) so a fresh triage/case exists even if
    // the modal never opened the review page. Then preselect from the current cases.
    void (async () => {
      try {
        await ensureCasesForRun(initialRunId)
      } catch {
        /* non-fatal — the page still renders whatever cases already exist */
      }
    })()
    const sections = groupCasesByRun(cases)
    const target = preselectForRun(sections, initialRunId)
    if (target) setSelectedId(target)
    setScrollToRunId(initialRunId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRunId])

  const selectedCase = React.useMemo<CaseDetailRow | null>(() => {
    const c = cases.find((x) => x.id === selectedId)
    if (!c) return null
    return {
      id: c.id,
      report_type: c.report_type,
      kind: c.kind,
      natural_key: c.natural_key,
      reason: c.reason,
      detail: c.detail,
      row: c.row,
      status: c.status,
      occurrence_count: c.occurrence_count,
      known_ruling_id: c.known_ruling_id,
      known_ruling_summary: c.known_ruling_summary,
      verdict: c.verdict,
    }
  }, [cases, selectedId])

  const busy = selectedCase?.status === 'investigating'
  const isTriageSelected = selectedCase?.kind === 'run_triage'

  // ── The open SINGLE resolution proposal (P5) — non-triage cases only. ──
  const openProposal = React.useMemo(() => {
    if (!selectedCase || selectedCase.status === 'resolved' || isTriageSelected) return null
    const scan: ProposalScanRow[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_results: m.tool_results,
      position: m.position,
    }))
    return findOpenProposal(scan, selectedCase.status)
  }, [messages, selectedCase, isTriageSelected])

  const openProposalMessageId = React.useMemo(() => {
    if (!openProposal) return null
    const msg = messages.find((m) => m.position === openProposal.position)
    return msg?.id ?? null
  }, [openProposal, messages])

  // ── The open GROUP resolution proposal (v1.1) — triage cases only. ──
  const openGroupProposal = React.useMemo(() => {
    if (!selectedCase || selectedCase.status === 'resolved' || !isTriageSelected) return null
    const scan: ProposalScanRow[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_results: m.tool_results,
      position: m.position,
    }))
    return findOpenGroupProposal(scan, selectedCase.status)
  }, [messages, selectedCase, isTriageSelected])

  const openGroupProposalMessageId = React.useMemo(() => {
    if (!openGroupProposal) return null
    const msg = messages.find((m) => m.position === openGroupProposal.position)
    return msg?.id ?? null
  }, [openGroupProposal, messages])

  // ── R3b: the source_diff pick flow — the SourceDiff + the open pick plan. ──
  const isSourceDiffSelected = selectedCase?.kind === 'source_diff'

  const sourceDiff = React.useMemo(() => {
    if (!selectedCase || !isSourceDiffSelected) return null
    return asSourceDiff(selectedCase.row)
  }, [selectedCase, isSourceDiffSelected])

  const openPickPlan = React.useMemo<OpenPickPlan | null>(() => {
    if (!selectedCase || selectedCase.status === 'resolved' || !isSourceDiffSelected) return null
    const scan: PickSourceScanRow[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      position: m.position,
    }))
    const open = findOpenPickSourcePlan(scan, selectedCase.status)
    if (!open) return null
    return { source: open.input.source, plan: open.input.plan }
  }, [messages, selectedCase, isSourceDiffSelected])

  const openPickMessageId = React.useMemo(() => {
    if (!selectedCase || selectedCase.status === 'resolved' || !isSourceDiffSelected) return null
    const scan: PickSourceScanRow[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      position: m.position,
    }))
    const open = findOpenPickSourcePlan(scan, selectedCase.status)
    if (!open) return null
    const msg = messages.find((m) => m.position === open.position)
    return msg?.id ?? null
  }, [messages, selectedCase, isSourceDiffSelected])

  // ── Create-batch: the open, persisted create-batch proposal for a batch case. ──
  const isBatchCaseSelected =
    selectedCase?.kind === 'unmapped_batch_code' || selectedCase?.kind === 'unresolved_batch'

  const openCreateBatch = React.useMemo(() => {
    if (!selectedCase || selectedCase.status === 'resolved' || !isBatchCaseSelected) return null
    const scan: CreateBatchScanRow[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      position: m.position,
    }))
    return findOpenCreateBatchPlan(scan, selectedCase.status)
  }, [messages, selectedCase, isBatchCaseSelected])

  const openCreateBatchPlan = React.useMemo<CreateBatchPlan | null>(
    () => openCreateBatch?.input.plan ?? null,
    [openCreateBatch],
  )

  const openCreateBatchMessageId = React.useMemo(() => {
    if (!openCreateBatch) return null
    const msg = messages.find((m) => m.position === openCreateBatch.position)
    return msg?.id ?? null
  }, [openCreateBatch, messages])

  // The run family's cases (to render the group card's member rows), keyed off the
  // selected triage case's run.
  const groupMembers = React.useMemo<GroupMemberCase[]>(() => {
    if (!isTriageSelected || !selectedCase) return []
    const runId = cases.find((c) => c.id === selectedCase.id)?.last_run_id
    if (!runId) return []
    return cases
      .filter((c) => c.last_run_id === runId && c.kind !== 'run_triage')
      .map((c) => ({ id: c.id, natural_key: c.natural_key, kind: c.kind }))
  }, [cases, selectedCase, isTriageSelected])

  // ── Load the selected case's transcript (server), then Realtime keeps it live ──
  const loadMessages = React.useCallback(async (caseId: string) => {
    try {
      const { messages: msgs } = await getCaseWithMessages(caseId)
      if (selectedIdRef.current !== caseId) return
      setMessages(
        (msgs ?? []).map((m) => ({
          id: m.id,
          role: m.role as ThreadMessage['role'],
          content: m.content,
          tool_calls: m.tool_calls,
          tool_results: m.tool_results,
          position: m.position,
        })),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errorToast('Could not load the conversation', { description: message })
    }
  }, [])

  React.useEffect(() => {
    if (!selectedId) {
      setMessages([])
      return
    }
    void loadMessages(selectedId)
  }, [selectedId, loadMessages])

  // ── Realtime: whole-table changes on sync_held_cases → refresh the list rows ──
  React.useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('sync-cases-list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sync_held_cases' },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          const raw = (payload.new ?? payload.old) as Record<string, unknown>
          if (!raw?.id) return
          const id = String(raw.id)
          if (payload.eventType === 'DELETE') {
            setCases((prev) => prev.filter((c) => c.id !== id))
            return
          }
          setCases((prev) => {
            const existing = prev.find((c) => c.id === id)
            const wire = toWireCase(payload.new as Record<string, unknown>, existing)
            if (existing) return prev.map((c) => (c.id === id ? wire : c))
            return [wire, ...prev]
          })
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  // ── Realtime: message INSERTs for the SELECTED case → append to the thread ──
  React.useEffect(() => {
    if (!selectedId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`sync-case-msgs-${selectedId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'sync_case_messages',
          filter: `case_id=eq.${selectedId}`,
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          const msg = toThreadMessage(payload.new as Record<string, unknown>)
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev
            const next = [...prev, msg]
            next.sort((a, b) => a.position - b.position)
            return next
          })
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [selectedId])

  // ── Cluster chip filter (per run). ──
  const onToggleCluster = React.useCallback((runId: string, caseIds: string[] | null) => {
    setClusterFilter((prev) => ({ ...prev, [runId]: caseIds }))
  }, [])

  // ── Bulk selection. Prune ids that become non-selectable (resolved/removed). ──
  const onToggleBulk = React.useCallback((id: string, on: boolean) => {
    setSelectedForBulk((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  React.useEffect(() => {
    setSelectedForBulk((prev) => {
      if (prev.size === 0) return prev
      const stillValid = new Set(
        cases.filter((c) => isBulkSelectable(c)).map((c) => c.id),
      )
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (stillValid.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [cases])

  const clearBulk = React.useCallback(() => setSelectedForBulk(new Set()), [])

  // ── Actions: fire-and-forget (Realtime drives the UI back). ──
  const runInvestigate = React.useCallback(
    (caseId: string, opts?: { escalate?: boolean; force?: boolean }) => {
      setCases((prev) =>
        prev.map((c) => (c.id === caseId ? { ...c, status: 'investigating' } : c)),
      )
      void investigateCase(caseId, opts).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        errorToast('Investigation failed', { description: message })
        setCases((prev) =>
          prev.map((c) => (c.id === caseId && c.status === 'investigating' ? { ...c, status: 'open' } : c)),
        )
      })
    },
    [],
  )

  const onInvestigate = React.useCallback(() => {
    if (selectedId) runInvestigate(selectedId)
  }, [selectedId, runInvestigate])
  const onReinvestigate = React.useCallback(() => {
    if (selectedId) runInvestigate(selectedId, { force: true })
  }, [selectedId, runInvestigate])
  const onEscalate = React.useCallback(() => {
    if (selectedId) runInvestigate(selectedId, { escalate: true, force: true })
  }, [selectedId, runInvestigate])

  const onSend = React.useCallback(
    async (text: string) => {
      const caseId = selectedIdRef.current
      if (!caseId) return
      const optimistic: ThreadMessage = {
        id: `optimistic-${Date.now()}`,
        role: 'user',
        content: text,
        tool_calls: null,
        tool_results: null,
        position: Number.MAX_SAFE_INTEGER,
      }
      setMessages((prev) => [...prev, optimistic])
      setChatPending(true)
      try {
        const res = await chatOnCase(caseId, text)
        if (!res.ok) {
          errorToast('Could not send your message', { description: res.error ?? 'Unknown error' })
        }
        await loadMessages(caseId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errorToast('Could not send your message', { description: message })
        await loadMessages(caseId)
      } finally {
        setChatPending(false)
      }
    },
    [loadMessages],
  )

  // ── P5: confirm / decline a single proposal, and quick-dismiss. ──
  const onConfirmResolution = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openProposalMessageId) return
    setResolvePending(true)
    try {
      const res = await executeResolution(caseId, openProposalMessageId)
      if (!res.ok) errorToast('Could not apply the resolution', { description: res.error ?? 'Unknown error' })
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not apply the resolution', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setResolvePending(false)
    }
  }, [openProposalMessageId, loadMessages])

  const onDeclineResolution = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openProposalMessageId) return
    setResolvePending(true)
    try {
      const res = await cancelProposal(caseId, openProposalMessageId)
      if (!res.ok) errorToast('Could not decline the proposal', { description: res.error ?? 'Unknown error' })
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not decline the proposal', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setResolvePending(false)
    }
  }, [openProposalMessageId, loadMessages])

  // ── v1.1: confirm / decline a GROUP proposal (triage case). ──
  const onConfirmGroupResolution = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openGroupProposalMessageId) return
    setResolvePending(true)
    try {
      const res = await executeGroupResolution(caseId, openGroupProposalMessageId)
      if (!res.ok) {
        const first = res.errors[0]?.error ?? 'Unknown error'
        errorToast('Could not dismiss the group', {
          description: res.errors.length > 1 ? `${first} (+${res.errors.length - 1} more)` : first,
        })
      }
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not dismiss the group', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setResolvePending(false)
    }
  }, [openGroupProposalMessageId, loadMessages])

  const onDeclineGroupResolution = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openGroupProposalMessageId) return
    setResolvePending(true)
    try {
      const res = await cancelProposal(caseId, openGroupProposalMessageId)
      if (!res.ok) errorToast('Could not decline the group', { description: res.error ?? 'Unknown error' })
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not decline the group', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setResolvePending(false)
    }
  }, [openGroupProposalMessageId, loadMessages])

  // ── R3b: propose / confirm / decline a source_diff pick. ──
  const onProposePickSource = React.useCallback(
    async (source: RcOutSource) => {
      const caseId = selectedIdRef.current
      if (!caseId) return
      setResolvePending(true)
      try {
        const res = await proposePickSource(caseId, source)
        if (!res.ok) {
          errorToast('Could not prepare the pick', { description: res.error ?? 'Unknown error' })
        }
        // The proposal is persisted as an assistant message — reload so the confirm card
        // renders from the transcript (Realtime also drives this; the reload makes it snappy).
        await loadMessages(caseId)
      } catch (err) {
        errorToast('Could not prepare the pick', {
          description: err instanceof Error ? err.message : String(err),
        })
        await loadMessages(caseId)
      } finally {
        setResolvePending(false)
      }
    },
    [loadMessages],
  )

  const onConfirmDiffResolution = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openPickMessageId) return
    setResolvePending(true)
    try {
      const res = await executeDiffResolution(caseId, openPickMessageId)
      if (!res.ok) errorToast('Could not apply the pick', { description: res.error ?? 'Unknown error' })
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not apply the pick', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setResolvePending(false)
    }
  }, [openPickMessageId, loadMessages])

  const onDeclineDiffResolution = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openPickMessageId) return
    setResolvePending(true)
    try {
      const res = await cancelProposal(caseId, openPickMessageId)
      if (!res.ok) errorToast('Could not decline the pick', { description: res.error ?? 'Unknown error' })
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not decline the pick', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setResolvePending(false)
    }
  }, [openPickMessageId, loadMessages])

  // ── Create-batch: propose / confirm / decline. ──
  const onCreateBatch = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId) return
    setResolvePending(true)
    try {
      const res = await proposeCreateBatch(caseId)
      if (!res.ok) {
        errorToast('Could not prepare the batch', { description: res.error ?? 'Unknown error' })
      }
      // The proposal is persisted as an assistant message — reload so the confirm card
      // renders from the transcript (Realtime also drives this; the reload makes it snappy).
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not prepare the batch', {
        description: err instanceof Error ? err.message : String(err),
      })
      await loadMessages(caseId)
    } finally {
      setResolvePending(false)
    }
  }, [loadMessages])

  const onConfirmCreateBatch = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openCreateBatchMessageId) return
    setResolvePending(true)
    try {
      const res = await executeCreateBatch(caseId, openCreateBatchMessageId)
      if (!res.ok) {
        errorToast('Could not create the batch', { description: res.error ?? 'Unknown error' })
      } else {
        const created = res.created_batch ? 'Created' : 'Reused existing'
        const rows = res.rows_written ?? 0
        const rowPart = rows > 0 ? ` and wrote ${rows} row${rows === 1 ? '' : 's'}` : ''
        toast.success(`${created} batch${rowPart}`, {
          description:
            res.warnings && res.warnings.length > 0 ? res.warnings.join(' · ') : undefined,
          duration: 6000,
        })
      }
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not create the batch', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setResolvePending(false)
    }
  }, [openCreateBatchMessageId, loadMessages])

  const onDeclineCreateBatch = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openCreateBatchMessageId) return
    setResolvePending(true)
    try {
      const res = await cancelProposal(caseId, openCreateBatchMessageId)
      if (!res.ok) errorToast('Could not decline the batch', { description: res.error ?? 'Unknown error' })
      await loadMessages(caseId)
    } catch (err) {
      errorToast('Could not decline the batch', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setResolvePending(false)
    }
  }, [openCreateBatchMessageId, loadMessages])

  const onQuickDismissSubmit = React.useCallback(
    async (reason: string) => {
      const caseId = selectedIdRef.current
      if (!caseId) return
      setResolvePending(true)
      try {
        const res = await quickDismiss(caseId, reason)
        if (!res.ok) errorToast('Could not dismiss the case', { description: res.error ?? 'Unknown error' })
        else setQuickDismissOpen(false)
        await loadMessages(caseId)
      } catch (err) {
        errorToast('Could not dismiss the case', { description: err instanceof Error ? err.message : String(err) })
      } finally {
        setResolvePending(false)
      }
    },
    [loadMessages],
  )

  // ── Bulk dismiss (multi-select). ──
  const onBulkDismissSubmit = React.useCallback(
    async (reason: string) => {
      const ids = Array.from(selectedForBulk)
      if (ids.length === 0) return
      setResolvePending(true)
      try {
        const res = await bulkDismissCases(ids, reason)
        if (!res.ok) {
          const first = res.errors[0]?.error ?? 'Unknown error'
          errorToast('Could not dismiss the selected cases', {
            description: res.errors.length > 1 ? `${first} (+${res.errors.length - 1} more)` : first,
          })
        } else {
          setBulkDismissOpen(false)
          clearBulk()
        }
      } catch (err) {
        errorToast('Could not dismiss the selected cases', { description: err instanceof Error ? err.message : String(err) })
      } finally {
        setResolvePending(false)
      }
    },
    [selectedForBulk, clearBulk],
  )

  const bulkCount = selectedForBulk.size

  // ── "Copy all for Claude": the visible cases (minus the synthetic triage summaries)
  //    folded into diagnosis-ready entries, each carrying the investigator's verdict read. ──
  const claudeCases = React.useMemo<SerializableCase[]>(
    () =>
      cases
        .filter((c) => c.kind !== 'run_triage')
        .map((c) => {
          const v = asVerdict(c.verdict)
          return {
            kind: c.kind,
            report_type: c.report_type,
            natural_key: c.natural_key,
            status: c.status,
            reason: c.reason,
            detail: c.detail,
            row: c.row,
            occurrence_count: c.occurrence_count,
            verdict: v?.verdict ?? null,
            verdictSummary: v?.summary ?? null,
          }
        }),
    [cases],
  )

  // The load-bearing run id for the block header: the deep-linked run, else the single
  // run all cases share, else null (the page may span multiple runs).
  const copyRunId = React.useMemo(() => {
    if (initialRunId) return initialRunId
    const runs = new Set(
      cases.map((c) => c.last_run_id).filter((r): r is string => Boolean(r)),
    )
    return runs.size === 1 ? [...runs][0] : null
  }, [initialRunId, cases])

  const onCopyAllForClaude = React.useCallback(() => {
    const text = serializeCasesForClaude(claudeCases, { runId: copyRunId, status: 'open' })
    void navigator.clipboard.writeText(text).then(
      () =>
        toast.success(`Copied ${claudeCases.length} case${claudeCases.length === 1 ? '' : 's'}`, {
          duration: 2000,
        }),
      (err) =>
        errorToast('Could not copy the cases', {
          description: err instanceof Error ? err.message : String(err),
        }),
    )
  }, [claudeCases, copyRunId])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Run/page header: copy every open case as a diagnosis-ready block for Claude Code. */}
      {claudeCases.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <span className="text-[11px] font-medium text-muted-foreground">
            {claudeCases.length} open {claudeCases.length === 1 ? 'case' : 'cases'}
          </span>
          <button
            type="button"
            onClick={onCopyAllForClaude}
            title="Copy every open case as a diagnosis-ready block to paste into Claude Code"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[11px] font-medium text-foreground transition-all duration-150 hover:bg-muted"
          >
            <Copy className="h-3 w-3" />
            Copy all for Claude
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left: run-grouped case list */}
        <div className="flex w-[400px] shrink-0 flex-col border-r border-border">
          <RunGroupedList
            cases={cases}
            selectedId={selectedId}
            onSelect={setSelectedId}
            filter={filter}
            onFilterChange={setFilter}
            showResolved={showResolved}
            onToggleResolved={setShowResolved}
            clusterFilter={clusterFilter}
            onToggleCluster={onToggleCluster}
            selectedForBulk={selectedForBulk}
            onToggleBulk={onToggleBulk}
            scrollToRunId={scrollToRunId}
          />

          {/* Selection bar (bulk dismiss). */}
          {bulkCount > 0 && (
            <div className="animate-fade-up flex items-center gap-2 border-t border-border bg-background/95 px-2 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <span className="text-[11px] font-medium text-foreground">
                {bulkCount} selected
              </span>
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={clearBulk}
              >
                Clear
              </Button>
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                disabled={resolvePending}
                onClick={() => setBulkDismissOpen(true)}
              >
                <XCircle className="h-3 w-3" />
                Dismiss {bulkCount} selected…
              </Button>
            </div>
          )}
        </div>

        {/* Right: detail / chat */}
        <div className="min-w-0 flex-1">
          {selectedCase ? (
            <CaseDetail
              key={selectedCase.id}
              theCase={selectedCase}
              messages={messages}
              busy={!!busy}
              onInvestigate={onInvestigate}
              onReinvestigate={onReinvestigate}
              onEscalate={onEscalate}
              onSend={onSend}
              chatPending={chatPending}
              openProposal={openProposal}
              onConfirmResolution={onConfirmResolution}
              onDeclineResolution={onDeclineResolution}
              resolvePending={resolvePending}
              onQuickDismiss={() => setQuickDismissOpen(true)}
              openGroupProposal={openGroupProposal}
              groupMembers={groupMembers}
              onConfirmGroupResolution={onConfirmGroupResolution}
              onDeclineGroupResolution={onDeclineGroupResolution}
              sourceDiff={sourceDiff}
              openPickPlan={openPickPlan}
              onProposePickSource={onProposePickSource}
              onConfirmDiffResolution={onConfirmDiffResolution}
              onDeclineDiffResolution={onDeclineDiffResolution}
              openCreateBatchPlan={openCreateBatchPlan}
              onCreateBatch={onCreateBatch}
              onConfirmCreateBatch={onConfirmCreateBatch}
              onDeclineCreateBatch={onDeclineCreateBatch}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <Inbox className="h-6 w-6 text-muted-foreground/60" />
              <p className="text-sm font-medium text-foreground">Nothing needs review</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Held rows from a sync land here as cases, grouped by run. When one shows up, select it
                to see the investigation and chat with the investigator.
              </p>
            </div>
          )}
        </div>
      </div>

      <QuickDismissDialog
        open={quickDismissOpen}
        onOpenChange={setQuickDismissOpen}
        onSubmit={onQuickDismissSubmit}
        pending={resolvePending}
      />
      <QuickDismissDialog
        open={bulkDismissOpen}
        onOpenChange={setBulkDismissOpen}
        onSubmit={onBulkDismissSubmit}
        pending={resolvePending}
        count={bulkCount}
      />
    </div>
  )
}
