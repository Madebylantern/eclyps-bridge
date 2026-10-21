import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { APP_TITLE } from "@/lib/deployment";
import "../globals.css";

// Self-hosted from the repo (src/fonts): a build needs no network, and the page makes no runtime
// requests to Google or any other third party. The same faces as the landing: Inter for display and
// body, IBM Plex Mono for data.
const inter = localFont({ src: "../../fonts/inter-latin.woff2", weight: "200 500", variable: "--font-inter", display: "swap" });
const mono = localFont({ src: "../../fonts/ibm-plex-mono-400-latin.woff2", weight: "400", variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: APP_TITLE,
  description: "Move fixed USDC notes from Solana into Aztec and claim them privately.",
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
