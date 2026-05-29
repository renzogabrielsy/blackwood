import type { Metadata } from "next";
import { Atkinson_Hyperlegible } from "next/font/google";
import { Toaster } from "sonner";
import { Providers } from "@/components/providers";
import "./globals.css";

const atkinsonSans = Atkinson_Hyperlegible({
  variable: "--font-atkinson-sans",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Blackwood",
  description: "Industrial inventory management for charcoal processing",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${atkinsonSans.variable} antialiased`}
      >
        <Providers>
          {children}
        </Providers>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
