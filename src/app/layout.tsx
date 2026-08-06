import type { Metadata } from "next";
import { Space_Grotesk, Inter, Fragment_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  metadataBase: new URL("https://one.hushh.ai"),
  title: "One by hussh",
  description: "Meet One, your personal intelligence agent.",
  // Google Search Console HTML-tag verification for the one.hushh.ai property.
  // Set GOOGLE_SITE_VERIFICATION (the token from Search Console) in the Cloud Run
  // service env; renders <meta name="google-site-verification" ...> when present.
  // Not needed if hushh.ai is verified as a *Domain* property (covers all subdomains).
  verification: { google: process.env.GOOGLE_SITE_VERIFICATION },
  // Installed-app behavior (Add to Home Screen): full-screen, dark status bar, named Adam.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Adam" },
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🤫%3C/text%3E%3C/svg%3E",
    apple: "/icon.png",
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
  // Site-wide structured data: the publisher (Hushh) and the site (One), so
  // search engines can attribute the One / network pages to the brand.
  const orgJsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://hushh.ai/#org",
        name: "Hushh",
        url: "https://hushh.ai",
      },
      {
        "@type": "WebSite",
        "@id": "https://one.hushh.ai/#website",
        name: "One by hushh",
        url: "https://one.hushh.ai",
        publisher: { "@id": "https://hushh.ai/#org" },
      },
    ],
  };
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${inter.variable} ${fragmentMono.variable}`}>
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }} />
        {children}
      </body>
    </html>
  );
}
