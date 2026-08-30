import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prime Technical Live Scanner",
  description: "Intraday NIFTY 500 PDH/PDL scanner — 5-minute confirmation, volume, and 20 EMA alignment.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
