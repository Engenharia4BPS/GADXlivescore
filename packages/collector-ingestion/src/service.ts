import { redactReceipt } from "./canonical.js";
import type { IngestionRepository } from "./repository.js";
import type {
  CollectorReceipt,
  PayloadAdapter,
  ReceiptResult,
} from "./types.js";

export class CollectorIngestionService {
  constructor(private readonly repository: IngestionRepository) {}
  async ingest(
    receipt: CollectorReceipt,
    adapter: PayloadAdapter,
  ): Promise<ReceiptResult> {
    const redacted = redactReceipt(receipt);
    const rawMessageId = await this.repository.createReceipt(redacted);
    await this.repository.claim(rawMessageId, receipt.receivedAt);
    let observationCount = 0;
    let rejectedCount = 0;
    try {
      const parsed = adapter.parse(redacted);
      observationCount = parsed.observations.length + parsed.rejected.length;
      rejectedCount = parsed.rejected.length;
      const persisted = await this.repository.persistObservations(
        rawMessageId,
        receipt.receivedAt,
        parsed.observations,
      );
      const result: ReceiptResult = {
        rawMessageId,
        observationCount,
        acceptedCount: persisted.accepted,
        duplicateCount: persisted.duplicates,
        rejectedCount,
        status: finalStatus(
          persisted.accepted,
          persisted.duplicates,
          parsed.rejected.length,
        ),
      };
      await this.repository.finish(
        rawMessageId,
        result,
        parsed.rejected.length ? { rejected_rows: parsed.rejected } : null,
      );
      return result;
    } catch (error) {
      const result: ReceiptResult = {
        rawMessageId,
        observationCount,
        acceptedCount: 0,
        duplicateCount: 0,
        rejectedCount,
        status: "FAILED",
      };
      await this.repository.finish(rawMessageId, result, {
        error:
          error instanceof Error ? error.message : "Unknown parse failure.",
      });
      return result;
    }
  }
}
function finalStatus(
  accepted: number,
  duplicates: number,
  rejected: number,
): ReceiptResult["status"] {
  if (rejected && (accepted || duplicates)) return "PARTIAL";
  if (rejected) return "FAILED";
  return "PROCESSED";
}
