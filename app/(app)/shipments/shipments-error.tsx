"use client";

// Inline error banner for the Shipments module. Per the project HARD RULE, error
// UI must PERSIST until dismissed and expose a Copy button that grabs the full
// error text (users paste it into Claude for debugging). This is the inline-banner
// variant of that rule (the page renders on the server, so a toast isn't available
// at first paint — an inline banner is the right surface here).

import { useState } from "react";
import { AlertTriangle, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ShipmentsError({ message }: { message: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(message).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-destructive">Could not load shipments from Trello</p>
          <p className="mt-1 break-words font-mono text-xs text-destructive/90">{message}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            This is a read-only Trello lookup. Check that the API credentials are configured
            (env vars in production, or the local credentials file in dev).
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={copy}
          className="shrink-0 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
