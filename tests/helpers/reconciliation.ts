/** gRPC access to the reconciliation service (port 50053), phase 2, item 3 (ADR-027). */
import { callUnary, makeClient } from '@switch/common';
import {
  BreakStatus,
  BreakType,
  ReconciliationServiceClient,
  type Break,
  type ReconciliationRun,
} from '@switch/proto-gen/reconciliation/v1';

const ADDR = process.env.RECONCILIATION_GRPC_ADDR ?? 'localhost:50053';

export interface BreakView {
  bankId: string;
  referenceId: string;
  operation: string;
  type: 'MISSING_IN_LEDGER' | 'MISSING_AT_BANK' | 'AMOUNT_MISMATCH' | 'UNSPECIFIED';
  bankAmount: bigint;
  ledgerAmount: bigint;
  status: 'OPEN' | 'RESOLVED';
}

const TYPE: Record<number, BreakView['type']> = {
  [BreakType.BREAK_TYPE_MISSING_IN_LEDGER]: 'MISSING_IN_LEDGER',
  [BreakType.BREAK_TYPE_MISSING_AT_BANK]: 'MISSING_AT_BANK',
  [BreakType.BREAK_TYPE_AMOUNT_MISMATCH]: 'AMOUNT_MISMATCH',
};

const toView = (b: Break): BreakView => ({
  bankId: b.bankId,
  referenceId: b.referenceId,
  operation: b.operation,
  type: TYPE[b.type] ?? 'UNSPECIFIED',
  bankAmount: BigInt(b.bankAmount),
  ledgerAmount: BigInt(b.ledgerAmount),
  status: b.status === BreakStatus.BREAK_STATUS_OPEN ? 'OPEN' : 'RESOLVED',
});

export class ReconciliationClient {
  private readonly client = makeClient(ReconciliationServiceClient, ADDR);

  /** Runs reconciliation now over `[from, to)`; resolves with the run summary. */
  run(from: Date, to: Date): Promise<ReconciliationRun> {
    return callUnary(this.client.runReconciliation.bind(this.client), { from, to }, { timeoutMs: 300_000 });
  }

  /** Breaks, optionally only OPEN ones and only for these reference ids. */
  async report(
    filter: { openOnly?: boolean; referenceIds?: string[]; limit?: number } = {},
  ): Promise<{ breaks: BreakView[]; openBreaks: number; latestRun: ReconciliationRun | undefined }> {
    const res = await callUnary(
      this.client.getReport.bind(this.client),
      {
        status: filter.openOnly === true ? BreakStatus.BREAK_STATUS_OPEN : BreakStatus.BREAK_STATUS_UNSPECIFIED,
        referenceIds: filter.referenceIds ?? [],
        limit: filter.limit ?? 0,
      },
      { timeoutMs: 30_000 },
    );
    return { breaks: res.breaks.map(toView), openBreaks: res.openBreaks, latestRun: res.latestRun };
  }

  close(): void {
    this.client.close();
  }
}
