'use client'

import { useState } from 'react'
import { AlertTriangle, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface WidgetErrorProps {
  message: string
}

export function WidgetError({ message }: WidgetErrorProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(message)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
      <AlertTriangle className="h-6 w-6 text-amber-500 shrink-0" />
      <div className="space-y-1">
        <p className="text-xs font-medium text-foreground">Data unavailable</p>
        <p className="text-[10px] text-muted-foreground max-w-[200px] leading-relaxed">
          Adapter failed to fetch. Copy the error to diagnose.
        </p>
      </div>
      <button
        onClick={handleCopy}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[10px] font-mono transition-colors',
          'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground',
        )}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied!' : 'Copy error'}
      </button>
      {/* Hidden pre for screen readers / devtools */}
      <pre className="sr-only">{message}</pre>
    </div>
  )
}
