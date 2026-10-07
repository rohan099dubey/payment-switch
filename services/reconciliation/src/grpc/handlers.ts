import { status as Status } from '@grpc/grpc-js';
import { makeGrpcError, type Instrument } from '@switch/common';
import {
  BreakStatus,
  BreakType,
  type Break,
  type ReconciliationRun,
  type ReconciliationServiceServer,
} from '@switch/proto-gen/reconciliation/v1';
import type { Pool } from 'pg';
import { countOpenBreaks, latestRun, listBreaks, type BreakRecord, type RunRecord } from '../repo/reconRepo';
import type { ReconciliationRunner } from '../runner';

export const ReconErrorCode = { INVALID_REQUEST: 'INVALID_REQUEST' } as const;

const BREAK_TYPE: Record<string, BreakType> = {
  MISSING_IN_LEDGER: BreakType.BREAK_TYPE_MISSING_IN_LEDGER,
  MISSING_AT_BANK: BreakType.BREAK_TYPE_MISSING_AT_BANK,
  AMOUNT_MISMATCH: BreakType.BREAK_TYPE_AMOUNT_MISMATCH,
};

export function toProtoBreak(b: BreakRecord): Break {
  return {
    bankId: b.bankId,
    referenceId: b.referenceId,
    operation: b.operation,
    type: BREAK_TYPE[b.type] ?? BreakType.BREAK_TYPE_UNSPECIFIED,
    bankAmount: (b.bankAmount ?? 0n).toString(),
    ledgerAmount: (b.ledgerAmount ?? 0n).toString(),
    status: b.status === 'OPEN' ? BreakStatus.BREAK_STATUS_OPEN : BreakStatus.BREAK_STATUS_RESOLVED,
    firstSeenAt: b.firstSeenAt,
    lastSeenAt: b.lastSeenAt,
    resolvedAt: b.resolvedAt ?? undefined,
  };
}

export function toProtoRun(r: RunRecord): ReconciliationRun {
  return {
    runId: r.id,
    from: r.from,
    to: r.to,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? undefined,
    statementLines: r.statementLines ?? 0,
    journals: r.journals ?? 0,
    breaksOpened: r.breaksOpened ?? 0,
    breaksResolved: r.breaksResolved ?? 0,
    openBreaks: r.openBreaks ?? 0,
  };
}

export interface HandlerDeps {
  pool: Pool;
  runner: ReconciliationRunner;
  instrument: Instrument;
}

/** gRPC transport only (section 3): validation, mapping, error codes. SQL lives in repo/. */
export function createReconciliationHandlers({ pool, runner, instrument }: HandlerDeps): ReconciliationServiceServer {
  const invalid = (reason: string): Error =>
    makeGrpcError(Status.INVALID_ARGUMENT, ReconErrorCode.INVALID_REQUEST, reason);
  return {
    getReport: instrument('GetReport', async (request) => {
      const limit = request.limit === 0 ? 1000 : request.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw invalid('limit must be 0..10000');
      const status =
        request.status === BreakStatus.BREAK_STATUS_OPEN
          ? 'OPEN'
          : request.status === BreakStatus.BREAK_STATUS_RESOLVED
            ? 'RESOLVED'
            : null;
      const breaks = await listBreaks(pool, { status, referenceIds: request.referenceIds, limit });
      const latest = await latestRun(pool);
      return {
        breaks: breaks.map(toProtoBreak),
        latestRun: latest === null ? undefined : toProtoRun(latest),
        openBreaks: await countOpenBreaks(pool),
      };
    }),

    runReconciliation: instrument('RunReconciliation', async (request) => {
      const { from, to } = request;
      if (from === undefined || to === undefined || !(from < to)) throw invalid('from and to are required, from < to');
      const run = await runner.run(from, to, 'ON_DEMAND');
      if (run.error !== null) {
        throw makeGrpcError(Status.UNAVAILABLE, 'RECONCILIATION_FAILED', `reconciliation run failed: ${run.error}`);
      }
      return toProtoRun(run);
    }),
  };
}
