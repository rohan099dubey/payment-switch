import { status as Status } from '@grpc/grpc-js';
import { decodePageToken, encodePageToken, makeGrpcError, pageSize, type Instrument } from '@switch/common';
import {
  EntryDirection,
  type AccountBalance as ProtoAccountBalance,
  type Journal,
  type LedgerServiceServer,
} from '@switch/proto-gen/ledger/v1';
import type { Pool } from 'pg';
import { journalRequestHash } from '../domain/journalHash';
import { validatePostJournal } from '../domain/validate';
import type { LedgerMetrics } from '../metrics';
import { getBalance, getTrialBalance, type AccountBalance } from '../repo/balanceRepo';
import {
  getJournal,
  listJournalsByReference,
  listJournalsByTime,
  postJournal,
  type StoredJournal,
} from '../repo/journalRepo';

/** `x-error-code` values the Ledger sends (spec sections 7 and 14). */
export const LedgerErrorCode = {
  JOURNAL_INVALID: 'JOURNAL_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  JOURNAL_NOT_FOUND: 'JOURNAL_NOT_FOUND',
  /** ADR-017: the database's own triggers or CHECKs refused a journal the app accepted. */
  LEDGER_INVARIANT_VIOLATION: 'LEDGER_INVARIANT_VIOLATION',
  /** ADR-027: a malformed ListJournalsByTime request (window, page size or token). */
  INVALID_REQUEST: 'INVALID_REQUEST',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HandlerDeps {
  pool: Pool;
  metrics: LedgerMetrics;
  instrument: Instrument;
}

/** gRPC transport only: proto <-> domain mapping and error codes. SQL lives in repo/. */
export function createLedgerHandlers({ pool, metrics, instrument }: HandlerDeps): LedgerServiceServer {
  return {
    postJournal: instrument('PostJournal', async (request) => {
      const validation = validatePostJournal(request);
      if (!validation.ok) {
        throw makeGrpcError(Status.INVALID_ARGUMENT, LedgerErrorCode.JOURNAL_INVALID, validation.reason);
      }
      const journal = validation.journal;
      const outcome = await postJournal(pool, journal, journalRequestHash(journal));

      switch (outcome.status) {
        case 'key_reused':
          throw makeGrpcError(
            Status.ALREADY_EXISTS,
            LedgerErrorCode.IDEMPOTENCY_KEY_REUSED,
            `idempotency key ${journal.idempotencyKey} was already used for a different journal`,
          );
        case 'unknown_accounts':
          throw makeGrpcError(
            Status.NOT_FOUND,
            LedgerErrorCode.ACCOUNT_NOT_FOUND,
            `unknown account code(s): ${outcome.codes.join(', ')}`,
          );
        case 'rejected_by_database':
          // FAILED_PRECONDITION, not INTERNAL: the Orchestrator classifies it as BUG and
          // stops, instead of retrying a journal the database will never accept (ADR-017).
          throw makeGrpcError(
            Status.FAILED_PRECONDITION,
            LedgerErrorCode.LEDGER_INVARIANT_VIOLATION,
            `journal rejected by a ledger database invariant (SQLSTATE ${outcome.sqlstate}): ${outcome.message}`,
          );
        case 'created':
        case 'replayed': {
          const replayed = outcome.status === 'replayed';
          metrics.journalsPosted.inc({ kind: outcome.journal.kind, replayed: String(replayed) });
          return { journal: toProtoJournal(outcome.journal), replayed };
        }
      }
    }),

    getJournal: instrument('GetJournal', async (request) => {
      // A malformed id cannot name a journal; answer as absent rather than leak a SQL error.
      const journal = UUID.test(request.journalId) ? await getJournal(pool, request.journalId) : null;
      if (journal === null) {
        throw makeGrpcError(
          Status.NOT_FOUND,
          LedgerErrorCode.JOURNAL_NOT_FOUND,
          `journal ${request.journalId} not found`,
        );
      }
      return toProtoJournal(journal);
    }),

    listJournals: instrument('ListJournals', async (request) => {
      const journals = await listJournalsByReference(pool, request.referenceId);
      return { journals: journals.map(toProtoJournal) };
    }),

    getBalance: instrument('GetBalance', async (request) => {
      const balance = await getBalance(pool, request.accountCode);
      if (balance === null) {
        throw makeGrpcError(
          Status.NOT_FOUND,
          LedgerErrorCode.ACCOUNT_NOT_FOUND,
          `account ${request.accountCode} not found`,
        );
      }
      return toProtoBalance(balance);
    }),

    // Phase 2, item 3 (ADR-027): read-only, paged, for reconciliation.
    listJournalsByTime: instrument('ListJournalsByTime', async (request) => {
      const invalid = (reason: string): Error =>
        makeGrpcError(Status.INVALID_ARGUMENT, LedgerErrorCode.INVALID_REQUEST, reason);
      const { from, to } = request;
      if (from === undefined || to === undefined || !(from < to)) throw invalid('from and to are required, from < to');
      const limit = pageSize(request.pageSize);
      if (limit === null) throw invalid('page_size must be 0..1000');
      let after: [string, string] | null = null;
      if (request.pageToken !== '') {
        const key = decodePageToken(request.pageToken, 2);
        if (key === null || key[0] === undefined || key[1] === undefined || !UUID.test(key[1])) {
          throw invalid('malformed page_token');
        }
        after = [key[0], key[1]];
      }
      const page = await listJournalsByTime(pool, from, to, limit, after);
      return {
        journals: page.journals.map(toProtoJournal),
        nextPageToken: page.nextKey === null ? '' : encodePageToken(page.nextKey),
      };
    }),

    getTrialBalance: instrument('GetTrialBalance', async () => {
      const trial = await getTrialBalance(pool);
      return {
        accounts: trial.accounts.map(toProtoBalance),
        totalDebits: trial.totalDebits.toString(),
        totalCredits: trial.totalCredits.toString(),
        balanced: trial.balanced,
      };
    }),
  };
}

function toProtoJournal(journal: StoredJournal): Journal {
  return {
    journalId: journal.id,
    idempotencyKey: journal.idempotencyKey,
    referenceId: journal.referenceId,
    kind: journal.kind,
    description: journal.description ?? '',
    currency: journal.currency,
    lines: journal.lines.map((line) => ({
      accountCode: line.accountCode,
      direction: line.direction === 'D' ? EntryDirection.ENTRY_DIRECTION_DEBIT : EntryDirection.ENTRY_DIRECTION_CREDIT,
      amount: line.amount.toString(),
    })),
    createdAt: journal.createdAt,
  };
}

function toProtoBalance(balance: AccountBalance): ProtoAccountBalance {
  return {
    accountCode: balance.code,
    accountType: balance.type,
    debitTotal: balance.debitTotal.toString(),
    creditTotal: balance.creditTotal.toString(),
    balance: balance.balance.toString(),
    currency: balance.currency,
  };
}
