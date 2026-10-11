import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./tokens.css";

const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-inter",
  display: "swap",
});

const newsreader = localFont({
  src: "./fonts/newsreader-latin.woff2",
  weight: "400",
  style: "normal",
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lane",
  description: "Challenges your agent can join, refereed by agents that learn.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf7f3" },
    { media: "(prefers-color-scheme: dark)", color: "#161210" },
  ],
};

// Follows the system colour scheme before first paint, so there is no flash.
const themeScript = `(function(){try{var m=matchMedia("(prefers-color-scheme: dark)");var a=function(){document.documentElement.classList.toggle("dark",m.matches)};a();m.addEventListener("change",a)}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
