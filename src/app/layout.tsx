import type { Metadata } from "next";
import { Space_Grotesk, Inter, Fragment_Mono, Lexend } from "next/font/google";
import "./globals.css";

// Display / headings — Space Grotesk (the hellowstd.com display face).
const spaceGrotesk = Space_Grotesk({
  variable: "--font-grotesk",
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

// Lexend — used only on the /localfinder developer page (scoped in localfinder.module.css).
const lexend = Lexend({
  variable: "--font-lexend",
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
    <html lang="en" className={`${spaceGrotesk.variable} ${inter.variable} ${fragmentMono.variable} ${lexend.variable}`}>
      <body>{children}</body>
    </html>
  );
}
