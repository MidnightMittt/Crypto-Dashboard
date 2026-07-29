import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Leverage Terminal — Perp Funding & Open Interest",
  description:
    "Cross-exchange perpetual futures funding rates, open interest, and leverage positioning in one dashboard.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        {/*
          Fonts load via stylesheet rather than next/font on purpose: it keeps
          `next build` from depending on a network call to Google, and the app
          degrades to the system stack in tailwind.config.ts if the request
          fails. Swap to next/font if you'd rather self-host them.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
