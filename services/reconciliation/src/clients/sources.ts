import { callUnary, makeClient } from '@switch/common';
import { BankServiceClient, OperationStatus, OperationType } from '@switch/proto-gen/bank/v1';
import { EntryDirection, LedgerServiceClient, type Journal } from '@switch/proto-gen/ledger/v1';
import type { JournalView, Leg, LegOperation } from '../domain/legs';
import type { BankSide, LedgerSide } from '../domain/reconciler';

const PAGE_TIMEOUT_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 5_000;

const OPERATION_TO_TYPE: Record<LegOperation, OperationType> = {
  DEBIT: OperationType.OPERATION_TYPE_DEBIT,
  CREDIT: OperationType.OPERATION_TYPE_CREDIT,
  REVERSE_DEBIT: OperationType.OPERATION_TYPE_REVERSE_DEBIT,
};

function toLegOperation(type: OperationType): LegOperation {
  switch (type) {
    case OperationType.OPERATION_TYPE_DEBIT:
      return 'DEBIT';
    case OperationType.OPERATION_TYPE_CREDIT:
      return 'CREDIT';
    case OperationType.OPERATION_TYPE_REVERSE_DEBIT:
      return 'REVERSE_DEBIT';
    default:
      throw new Error(`bank returned an unknown operation type ${String(type)}`);
  }
}

export interface ClosableBankSide extends BankSide {
  close: () => void;
}

/** One bank over gRPC: `GetStatement` page by page, `GetOperation` by reference. */
export function createBankSide(bankId: string, address: string): ClosableBankSide {
  const client = makeClient(BankServiceClient, address);
  return {
    async *statement(from, to) {
      let pageToken = '';
      do {
        const page = await callUnary(
          client.getStatement.bind(client),
          { from, to, pageSize: 0, pageToken },
          { timeoutMs: PAGE_TIMEOUT_MS },
        );
        for (const line of page.lines) {
          const leg: Leg = {
            bankId,
            referenceId: line.referenceId,
            operation: toLegOperation(line.operation),
            amount: BigInt(line.amount),
          };
          yield leg;
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== '');
    },
    async operation(referenceId, operation) {
      const found = await callUnary(
        client.getOperation.bind(client),
        { referenceId, operation: OPERATION_TO_TYPE[operation] },
        { timeoutMs: LOOKUP_TIMEOUT_MS },
      );
      if (found.status !== OperationStatus.OPERATION_STATUS_APPLIED) return null;
      return { bankId, referenceId, operation, amount: BigInt(found.amount) };
    },
    close: () => {
      client.close();
    },
  };
}

function toView(journal: Journal): JournalView {
  return {
    referenceId: journal.referenceId,
    kind: journal.kind,
    lines: journal.lines.map((line) => ({
      accountCode: line.accountCode,
      direction: line.direction === EntryDirection.ENTRY_DIRECTION_DEBIT ? 'DEBIT' : 'CREDIT',
      amount: BigInt(line.amount),
    })),
  };
}

export interface ClosableLedgerSide extends LedgerSide {
  close: () => void;
}

/** The Ledger over gRPC: `ListJournalsByTime` page by page, `ListJournals` by reference. */
export function createLedgerSide(address: string): ClosableLedgerSide {
  const client = makeClient(LedgerServiceClient, address);
  return {
    async *journals(from, to) {
      let pageToken = '';
      do {
        const page = await callUnary(
          client.listJournalsByTime.bind(client),
          { from, to, pageSize: 0, pageToken },
          { timeoutMs: PAGE_TIMEOUT_MS },
        );
        for (const journal of page.journals) yield toView(journal);
        pageToken = page.nextPageToken;
      } while (pageToken !== '');
    },
    async byReference(referenceId) {
      const res = await callUnary(client.listJournals.bind(client), { referenceId }, { timeoutMs: LOOKUP_TIMEOUT_MS });
      return res.journals.map(toView);
    },
    close: () => {
      client.close();
    },
  };
}
