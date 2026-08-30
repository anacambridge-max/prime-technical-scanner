import { NextResponse } from "next/server";
import { runScan } from "@/lib/scanner";

export const dynamic = "force-dynamic"; // never statically cache live market data
export const runtime = "nodejs"; // needs fs (state persistence) and full fetch retry logic

export async function GET() {
  try {
    const result = await runScan();
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // Should be rare — runScan() itself is designed to degrade gracefully per-symbol.
    // This catch is the last resort for truly unexpected failures.
    const message = err instanceof Error ? err.message : "Unknown scanner error";
    return NextResponse.json(
      {
        meta: {
          scanTime: new Date().toISOString(),
          lastSuccessfulScanTime: null,
          marketOpen: false,
          marketStatus: "CLOSED",
          universeCount: 0,
          scannedCount: 0,
          errorCount: 1,
          dataStatus: "ERROR",
          errors: [{ symbol: "SCANNER", reason: message }],
          usedStaleData: false,
          message: "Scanner encountered an unexpected error. Showing no data for this cycle.",
        },
        counts: { confirmed: 0, setup: 0, watch: 0, universe: 0 },
        signals: [],
        log: [],
      },
      { status: 200 }
    );
  }
}
