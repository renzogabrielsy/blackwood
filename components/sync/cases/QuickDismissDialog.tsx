'use client'

import * as React from 'react'
import { Loader2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

interface QuickDismissDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Submit the reason; resolves when the server action settles. */
  onSubmit: (reason: string) => Promise<void>
  pending: boolean
  /**
   * When set (>1), the dialog is in MULTI (bulk) mode — the copy names N cases instead
   * of "this case". Undefined / 1 → single-case mode (unchanged).
   */
  count?: number
}

/**
 * The Quick Dismiss dialog — a required "why" reason, then a dismiss (zero
 * operational write). Human-directed by definition: the reviewer typed the reason and
 * clicked. Also serves the multi-select BULK dismiss (v1.1) when `count` > 1. Uses the
 * canonical glass dialog surface (bg-background/95 backdrop-blur-xl, inherited from
 * DialogContent).
 */
export function QuickDismissDialog({ open, onOpenChange, onSubmit, pending, count }: QuickDismissDialogProps) {
  const multi = (count ?? 1) > 1
  const [reason, setReason] = React.useState('')

  // Clear the reason when the dialog reopens.
  React.useEffect(() => {
    if (open) setReason('')
  }, [open])

  const canSubmit = reason.trim().length > 0 && !pending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-muted-foreground" />
            {multi ? `Dismiss ${count} selected cases` : 'Dismiss this case'}
          </DialogTitle>
          <DialogDescription>
            {multi
              ? 'Acknowledge these flags and set them aside together. Nothing in the database changes — this only records that a person looked and decided no action is needed.'
              : 'Acknowledge the flag and set it aside. Nothing in the database changes — this only records that a person looked and decided no action is needed.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label htmlFor="dismiss-reason" className="text-xs font-medium text-foreground">
            Why are you dismissing it? <span className="text-muted-foreground">(required)</span>
          </label>
          <Textarea
            id="dismiss-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. The movement sheet was short 13,743 kg on June 10 — the database is correct, nothing to fix."
            rows={3}
            disabled={pending}
            className="resize-none text-sm"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => void onSubmit(reason.trim())}
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
            {multi ? `Dismiss ${count} cases` : 'Dismiss case'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
