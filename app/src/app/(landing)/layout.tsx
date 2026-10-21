import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./landing.css";

// The landing has its own root layout so the app's Tailwind and tokens never load here. Fonts are
// self-hosted from the repo (src/fonts): a build needs no network, and the page makes no runtime
// requests to Google or any other third party.
const inter = localFont({ src: "../../fonts/inter-latin.woff2", weight: "200 400", variable: "--font-inter", display: "swap" });
const mono = localFont({ src: "../../fonts/ibm-plex-mono-400-latin.woff2", weight: "400", variable: "--font-plex-mono", display: "swap" });
// Face II, the owner's preview only (face.ts): not preloaded, so visitors never download it.
const marcellus = localFont({
  src: "../../fonts/marcellus-sc-400-latin.woff2", weight: "400", variable: "--font-marcellus", display: "swap", preload: false,
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  title: "Eclyps · The private bridge between Solana and Ethereum",
  description: "Move freely. Remain unseen. USDC from Solana to a private balance on Aztec, Ethereum's private layer, verifiable at every step.",
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} ${marcellus.variable}`}>
      <head>
        {/* `js`: the splash waits for the eclipse's first frame (landing.css). Returning visitors
            (they have opened the app before) go straight to it; the app's mark links back with
            ?landing, and a link to a section (#…) still opens the landing. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('js');try{if(location.pathname==='/'&&!location.hash&&location.search.indexOf('landing')<0&&localStorage.getItem('eclyps.app')==='1')location.replace('/app/')}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
