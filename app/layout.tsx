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
    // 'default' (NOT 'black-translucent') so iOS keeps the status bar as its own
    // opaque region and auto-insets the webview below it. black-translucent +
    // viewport-fit=cover drew content UNDER the status bar and required manual
    // safe-area padding on every top surface — reverted to the auto-inset behavior.
    statusBarStyle: "default",
    title: "Blackwood",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // NOTE: intentionally NOT viewportFit:'cover'. Edge-to-edge made content draw
  // under the iOS status bar / home indicator on every surface; the default
  // (auto-inset) is what we want. Do not re-add 'cover' without padding every
  // top+bottom surface with env(safe-area-inset-*).
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
