import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { Toaster } from "sonner";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Blackwood",
  description: "Industrial inventory management for charcoal processing",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    // 'black-translucent' is the coherent pairing with viewport-fit=cover below:
    // the status bar becomes a transparent overlay on top of OUR webview (which
    // now spans the full display), so it sits over the dark navbar rather than
    // stealing a strip of screen. See the viewport comment for the inset contract.
    statusBarStyle: "black-translucent",
    title: "Blackwood",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // EDGE-TO-EDGE CONTRACT — 'cover' is ON, and it is required: without it iOS
  // auto-insets the webview, which PILLARBOXES the app in landscape (black bars
  // down both sides). With 'cover' the webview fills the display on every device
  // and orientation — iPhone/iPad, portrait/landscape.
  //
  // The rule: BACKGROUNDS paint edge-to-edge, CONTENT is padded clear of the
  // notch / status bar / home indicator. That padding is owned centrally by the
  // shell + shared primitives, NOT re-applied ad hoc per surface (the previous
  // attempt at this was per-surface whack-a-mole and missed half the app):
  //
  //   app/globals.css                     -> .safe-t/.safe-b/.safe-l/.safe-r/.safe-x
  //   components/navbar.tsx               -> top + horizontal (the bar itself)
  //   app/(app)/app-shell.tsx             -> horizontal (page content region)
  //   components/ui/sheet.tsx             -> per-side, on SheetContent
  //   components/ui/dialog.tsx            -> horizontal + vertical clamp
  //   components/floating-status-bar.tsx  -> bottom + right
  //   app/(app)/inventory/_shared/blocking-detail-panel.tsx
  //                                       -> top + right (custom fixed overlay)
  //
  // If a new surface needs insets, it almost certainly belongs to one of the
  // primitives above — extend those, don't sprinkle env() at the call site.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#27272a" },
    { media: "(prefers-color-scheme: dark)", color: "#27272a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} antialiased`}
      >
        <Providers>
          {children}
        </Providers>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
