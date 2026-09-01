"use client";

// The project's HARD RULE is about every error SURFACE, not only toasts: an
// error persists until dismissed and always carries a Copy button, because the
// next thing that happens to it is being pasted into a Claude chat.

import * as React from "react";
import { AlertTriangle, Copy } from "lucide-react";

export function AnalyticsError({ message }: { message: string }) {
  const [copied, setCopied] = React.useState(false);
  const full = `Could not load Analytics\n\n${message}`;

  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-foreground">
            Could not load Analytics
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {message}
          </p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(full).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
            className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <Copy className="size-2.5" aria-hidden />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
