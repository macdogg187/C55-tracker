import type { Metadata } from "next";
import { Barlow, Outfit } from "next/font/google";
import { Suspense } from "react";
import { Nav } from "./components/Nav";
import "./globals.css";

const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "C55 TRACKER | Predictive Maintenance",
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
      className={`${barlow.variable} ${outfit.variable} h-full`}
    >
      <body className="flex min-h-full flex-col bg-[#FAFAF5] text-[#1A1A16]">
        <Suspense fallback={<div className="h-[52px] border-b-2 border-[#B0AD9E] bg-[#F0EFE8]" />}>
          <Nav />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
