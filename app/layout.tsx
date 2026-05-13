import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { Nav } from "./components/Nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "C55 Homogenizer | Predictive Maintenance Dashboard",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[#030711] text-zinc-100">
        <Suspense fallback={<div className="h-[52px] border-b border-zinc-800 bg-[#030711]" />}>
          <Nav />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
