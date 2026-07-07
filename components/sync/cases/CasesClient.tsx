'use client'

import * as React from 'react'
import { Inbox } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { errorToast } from '@/lib/toast'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { getCaseWithMessages, investigateCase } from '@/app/(app)/sync/cases'
import { chatOnCase } from '@/app/(app)/sync/case-chat'
import { executeResolution, cancelProposal, quickDismiss } from '@/app/(app)/sync/resolve'
import { findOpenProposal, type ProposalScanRow } from '@/lib/investigator/resolution'

import { CaseList, type CaseFilter, type CaseListRow } from './CaseList'
import { CaseDetail, type CaseDetailRow } from './CaseDetail'
import type { ThreadMessage } from './CaseThread'
import { QuickDismissDialog } from './QuickDismissDialog'

/** A held-case row as it arrives on the wire (list + Realtime share this shape). */
export interface WireCase extends CaseListRow {
  reason: string | null
  detail: string | null
  row: unknown
}

interface CasesClientProps {
  initialCases: WireCase[]
  initialError: string | null
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
    last_seen_at: String(raw.last_seen_at ?? new Date().toISOString()),
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

export function CasesClient({ initialCases, initialError }: CasesClientProps) {
  const [cases, setCases] = React.useState<WireCase[]>(initialCases)
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialCases[0]?.id ?? null,
  )
  const [messages, setMessages] = React.useState<ThreadMessage[]>([])
  const [chatPending, setChatPending] = React.useState(false)
  const [filter, setFilter] = React.useState<CaseFilter>('all')
  const [showResolved, setShowResolved] = React.useState(false)
  const [resolvePending, setResolvePending] = React.useState(false)
  const [quickDismissOpen, setQuickDismissOpen] = React.useState(false)

  const selectedIdRef = React.useRef<string | null>(selectedId)
  React.useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  React.useEffect(() => {
    if (initialError) errorToast('Could not load review cases', { description: initialError })
  }, [initialError])

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

  // ── The open resolution proposal (P5): the latest un-actioned propose_resolution ──
  // Computed from the live transcript. We also resolve the message id (for the
  // executeResolution / cancelProposal calls, which take proposalMessageId).
  const openProposal = React.useMemo(() => {
    if (!selectedCase || selectedCase.status === 'resolved') return null
    const scan: ProposalScanRow[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_results: m.tool_results,
      position: m.position,
    }))
    return findOpenProposal(scan, selectedCase.status)
  }, [messages, selectedCase])

  const openProposalMessageId = React.useMemo(() => {
    if (!openProposal) return null
    const msg = messages.find((m) => m.position === openProposal.position)
    return msg?.id ?? null
  }, [openProposal, messages])

  // ── Load the selected case's transcript (server), then Realtime keeps it live ──
  const loadMessages = React.useCallback(async (caseId: string) => {
    try {
      const { messages: msgs } = await getCaseWithMessages(caseId)
      // Only apply if still the selected case (avoid a stale async overwrite).
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

  // ── Realtime: whole-table UPDATE on sync_held_cases → refresh the list rows ──
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

  // ── Actions: fire-and-forget (Realtime drives the UI back). ──
  const runInvestigate = React.useCallback(
    (caseId: string, opts?: { escalate?: boolean; force?: boolean }) => {
      // Optimistically flip to 'investigating' so the buttons disable immediately.
      setCases((prev) =>
        prev.map((c) => (c.id === caseId ? { ...c, status: 'investigating' } : c)),
      )
      void investigateCase(caseId, opts).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        errorToast('Investigation failed', { description: message })
        // Reset the optimistic flip; Realtime will correct if the server did flip it.
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
      // Optimistic user bubble (Realtime will paint the persisted copy + reply).
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
        // Reconcile with the persisted transcript (drops the optimistic dupe).
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

  // ── P5: confirm / decline a proposal, and quick-dismiss. Realtime repaints. ──
  const onConfirmResolution = React.useCallback(async () => {
    const caseId = selectedIdRef.current
    if (!caseId || !openProposalMessageId) return
    setResolvePending(true)
    try {
      const res = await executeResolution(caseId, openProposalMessageId)
      if (!res.ok) {
        errorToast('Could not apply the resolution', { description: res.error ?? 'Unknown error' })
      }
      await loadMessages(caseId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errorToast('Could not apply the resolution', { description: message })
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
      if (!res.ok) {
        errorToast('Could not decline the proposal', { description: res.error ?? 'Unknown error' })
      }
      await loadMessages(caseId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errorToast('Could not decline the proposal', { description: message })
    } finally {
      setResolvePending(false)
    }
  }, [openProposalMessageId, loadMessages])

  const onQuickDismissSubmit = React.useCallback(
    async (reason: string) => {
      const caseId = selectedIdRef.current
      if (!caseId) return
      setResolvePending(true)
      try {
        const res = await quickDismiss(caseId, reason)
        if (!res.ok) {
          errorToast('Could not dismiss the case', { description: res.error ?? 'Unknown error' })
        } else {
          setQuickDismissOpen(false)
        }
        await loadMessages(caseId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errorToast('Could not dismiss the case', { description: message })
      } finally {
        setResolvePending(false)
      }
    },
    [loadMessages],
  )

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Left: case list */}
      <div className="flex w-[380px] shrink-0 flex-col border-r border-border">
        <CaseList
          cases={cases}
          selectedId={selectedId}
          onSelect={setSelectedId}
          filter={filter}
          onFilterChange={setFilter}
          showResolved={showResolved}
          onToggleResolved={setShowResolved}
        />
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
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Inbox className="h-6 w-6 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">Nothing needs review</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Held rows from a sync land here as cases. When one shows up, select it to see the
              investigation and chat with the investigator.
            </p>
          </div>
        )}
      </div>

      <QuickDismissDialog
        open={quickDismissOpen}
        onOpenChange={setQuickDismissOpen}
        onSubmit={onQuickDismissSubmit}
        pending={resolvePending}
      />
    </div>
  )
}
