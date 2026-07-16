'use client'

import { toast } from 'sonner'

/**
 * Build the full text we want copied to the clipboard.
 * Combines the headline message with any description.
 */
function buildCopyText(message: string, description?: string): string {
  return description ? `${message}\n\n${description}` : message
}

/**
 * Persistent error toast — stays on screen until the user dismisses it,
 * with a Copy button that grabs the full error text.
 *
 * Use this for EVERY error toast in the app instead of sonner's
 * `toast.error()` directly. See memory: `feedback_error_toasts.md`.
 */
export function errorToast(
  message: string | undefined | null,
  options?: { description?: string }
) {
  const resolved = message?.trim() || 'Something went wrong'
  const copyText = buildCopyText(resolved, options?.description)

  return toast.error(resolved, {
    description: options?.description,
    duration: Infinity,
    closeButton: true,
    action: {
      label: 'Copy',
      onClick: (event) => {
        event.preventDefault()
        void navigator.clipboard.writeText(copyText).then(() => {
          toast.success('Error copied to clipboard', { duration: 2000 })
        })
      },
    },
  })
}
