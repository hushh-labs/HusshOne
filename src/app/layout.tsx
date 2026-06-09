import type { Metadata } from "next";
import { Space_Grotesk, Inter, Fragment_Mono, Newsreader } from "next/font/google";
import "./globals.css";

// Display / headings — Space Grotesk (the hellowstd.com display face).
const spaceGrotesk = Space_Grotesk({
  variable: "--font-grotesk",
  subsets: ["latin"],
});

// Editorial serif — Newsreader (deep-research dossier body, standfirst, pull-quotes).
const newsreader = Newsreader({
  weight: ["400", "600"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
  subsets: ["latin"],
});

// Body + numeric — Inter.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Hex / code band — Fragment Mono (matches the hellow hero texture).
const fragmentMono = Fragment_Mono({
  weight: "400",
  variable: "--font-fragment",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "One by hussh",
  description: "Meet One, your personal intelligence agent.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🤫%3C/text%3E%3C/svg%3E",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${inter.variable} ${fragmentMono.variable} ${newsreader.variable}`}>
      <body>{children}</body>
    </html>
  );
}
