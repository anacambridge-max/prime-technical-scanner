import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prime Technical Live Scanner",
  description: "Intraday NSE F&O scanner — 5-minute PDH/PDL confirmation, volume, and 20 EMA alignment.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
