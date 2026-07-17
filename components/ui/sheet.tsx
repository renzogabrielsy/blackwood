"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

type Side = "top" | "right" | "bottom" | "left"

function Sheet({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/40 backdrop-blur-sm",
        className
      )}
      {...props}
    />
  )
}

/**
 * Per-side positioning + SAFE-AREA insets. Every Sheet in the app (nav menu, digest
 * sheets, card-list details, sync sheet) inherits its insets from here — call sites
 * must NOT add their own `env(safe-area-inset-*)` padding. See globals.css for the
 * edge-to-edge contract.
 *
 * Insets are applied only on the side the panel actually TOUCHES: env() reports the
 * VIEWPORT inset regardless of where the element sits, so e.g. a left-anchored sheet
 * gets `.safe-l` but never `.safe-r` (that would inject a phantom landscape gutter).
 * `left`/`right` are `inset-y-0` full-height, so they take top AND bottom too.
 *
 * The `.safe-*` classes are unlayered and therefore beat a caller's `p-0` — which is
 * exactly why the six bottom-sheet call sites could drop their now-redundant
 * `pb-[max(1rem,env(safe-area-inset-bottom))]`: that unanimous 1rem floor moved here
 * as `[--safe-b-min:1rem]`. A caller that wants a different floor sets that var.
 */
const sideClasses: Record<Side, string> = {
  right:
    "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm safe-t safe-r safe-b",
  left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm safe-t safe-l safe-b",
  top: "inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top safe-t safe-x",
  bottom:
    "inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom safe-b safe-x [--safe-b-min:1rem]",
}

/**
 * The default close button is `absolute`, which resolves against the content's PADDING
 * box — i.e. it ignores the `.safe-*` padding above and would land under the status bar
 * / notch. So it re-adds the insets to its own offsets. Only the sides the panel touches
 * (a `left` sheet is nowhere near the right notch; a `bottom` sheet never reaches the
 * status bar).
 */
const closeClasses: Record<Side, string> = {
  right:
    "top-[calc(0.75rem+env(safe-area-inset-top))] right-[calc(0.75rem+env(safe-area-inset-right))]",
  left: "top-[calc(0.75rem+env(safe-area-inset-top))] right-3",
  top: "top-[calc(0.75rem+env(safe-area-inset-top))] right-[calc(0.75rem+env(safe-area-inset-right))]",
  bottom: "top-3 right-[calc(0.75rem+env(safe-area-inset-right))]",
}

interface SheetContentProps
  extends React.ComponentProps<typeof SheetPrimitive.Content> {
  side?: Side
  showCloseButton?: boolean
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetContentProps) {
  return (
    <SheetPortal data-slot="sheet-portal">
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80 fixed z-50 flex flex-col gap-0 shadow-lg outline-none transition ease-in-out data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:duration-200 data-[state=open]:duration-250",
          sideClasses[side],
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close-default"
            className={cn(
              "ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute rounded-md opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 p-1",
              closeClasses[side]
            )}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 px-4 py-3", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 px-4 py-3", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-sm font-semibold tracking-tight", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-xs", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
}
