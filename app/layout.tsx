import type { Metadata } from "next";
import { Orbitron, IBM_Plex_Mono } from "next/font/google";
import { Suspense } from "react";
import { Nav } from "./components/Nav";
import "./globals.css";

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "600", "700", "900"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

export const metadata: Metadata = {
  title: "C55 MISSION CONTROL | Predictive Maintenance",
  description:
    "Industrial digital twin dashboard for MTBF tracking, runtime visibility, and sensor trend ingestion.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${orbitron.variable} ${ibmPlexMono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col bg-[#12100e] text-[#f0dfc0]">
        <Suspense fallback={<div className="h-[52px] border-b-2 border-[#2e2820] bg-[#0e0c0a]" />}>
          <Nav />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
