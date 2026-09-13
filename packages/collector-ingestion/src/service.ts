import { redactReceipt } from "./canonical.js";
import type { IngestionRepository } from "./repository.js";
import type {
  CollectorReceipt,
  PayloadAdapter,
  ReceiptResult,
} from "./types.js";

export class CollectorIngestionService {
  constructor(
    private readonly repository: IngestionRepository,
    private readonly reconciliationClock: () => string = utcNow,
  ) {}
  async ingest(
    receipt: CollectorReceipt,
    adapter: PayloadAdapter,
  ): Promise<ReceiptResult> {
    const redacted = redactReceipt(receipt);
    const rawMessageId = await this.repository.createReceipt(redacted);
    await this.repository.claim(rawMessageId, receipt.receivedAt);
    let observationCount = 0;
    let rejectedCount = 0;
    let acceptedCount = 0;
    let duplicateCount = 0;
    try {
      const parsed = adapter.parse(redacted);
      observationCount = parsed.observations.length + parsed.rejected.length;
      rejectedCount = parsed.rejected.length;
      const persisted = await this.repository.persistObservations(
        rawMessageId,
        receipt.receivedAt,
        parsed.observations,
      );
      const accepted = persisted.filter(
        (result): result is Extract<typeof result, { outcome: "ACCEPTED" }> =>
          result.outcome === "ACCEPTED",
      );
      acceptedCount = accepted.length;
      duplicateCount = persisted.filter(
        (result) => result.outcome === "DUPLICATE",
      ).length;
      rejectedCount += persisted.filter(
        (result) => result.outcome === "REJECTED",
      ).length;
      const persistenceRejections = persisted.filter(
        (result) => result.outcome === "REJECTED",
      );
      const reconciledAt = this.reconciliationClock();
      for (const result of accepted) {
        await this.repository.reconcileAcceptedSnapshot(
          result.snapshotId,
          reconciledAt,
        );
      }
      const result: ReceiptResult = {
        rawMessageId,
        observationCount,
        acceptedCount,
        duplicateCount,
        rejectedCount,
        status: finalStatus(acceptedCount, duplicateCount, rejectedCount),
      };
      await this.repository.finish(
        rawMessageId,
        result,
        rejectedCount
          ? {
              rejected_rows: parsed.rejected,
              persistence_rejections: persistenceRejections,
            }
          : null,
      );
      return result;
    } catch (error) {
      const result: ReceiptResult = {
        rawMessageId,
        observationCount,
        acceptedCount,
        duplicateCount,
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
function utcNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
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
