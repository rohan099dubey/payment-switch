import { callUnary, makeClient } from '@switch/common';
import { EntryDirection, LedgerServiceClient, type PostJournalRequest } from '@switch/proto-gen/ledger/v1';
import type { CallOptions, JournalLeg, LedgerPort } from '../domain/saga';
import type { Transfer } from '../domain/transfer';

export const JOURNAL_CURRENCY = 'INR';
export const TRANSIT_ACCOUNT = 'transit';

const KIND: Readonly<Record<JournalLeg, string>> = {
  'debit-leg': 'TRANSFER_DEBIT_LEG',
  'credit-leg': 'TRANSFER_CREDIT_LEG',
  reversal: 'TRANSFER_REVERSAL',
};

/** Derived from the transfer id, never random, so a retry after a crash regenerates it. */
export function journalIdempotencyKey(transferId: string, leg: JournalLeg): string {
  return `transfer:${transferId}:${leg}`;
}

/**
 * The three journal templates from spec section 7, and nothing else:
 *
 * | leg        | debit                     | credit                    |
 * | debit-leg  | `receivable:{payer_bank}` | `transit`                 |
 * | credit-leg | `transit`                 | `payable:{payee_bank}`    |
 * | reversal   | `transit`                 | `receivable:{payer_bank}` |
 */
export function buildJournal(
  t: Pick<Transfer, 'id' | 'payer' | 'payee' | 'amount'>,
  leg: JournalLeg,
): PostJournalRequest {
  const [debitAccount, creditAccount] = ((): [string, string] => {
    switch (leg) {
      case 'debit-leg':
        return [`receivable:${t.payer.bankId}`, TRANSIT_ACCOUNT];
      case 'credit-leg':
        return [TRANSIT_ACCOUNT, `payable:${t.payee.bankId}`];
      case 'reversal':
        return [TRANSIT_ACCOUNT, `receivable:${t.payer.bankId}`];
    }
  })();
  const amount = t.amount.toString();
  return {
    idempotencyKey: journalIdempotencyKey(t.id, leg),
    referenceId: t.id,
    kind: KIND[leg],
    description: '',
    currency: JOURNAL_CURRENCY,
    lines: [
      { accountCode: debitAccount, direction: EntryDirection.ENTRY_DIRECTION_DEBIT, amount },
      { accountCode: creditAccount, direction: EntryDirection.ENTRY_DIRECTION_CREDIT, amount },
    ],
  };
}

export function createLedgerClient(address: string): LedgerServiceClient {
  return makeClient(LedgerServiceClient, address);
}

/** The saga's view of the Ledger: `PostJournal` with one of the three templates. */
export function createLedgerPort(client: LedgerServiceClient): LedgerPort {
  return {
    postLeg: async (t: Transfer, leg: JournalLeg, options: CallOptions) => {
      const response = await callUnary(client.postJournal.bind(client), buildJournal(t, leg), options);
      return { journalId: response.journal?.journalId ?? '', replayed: response.replayed };
    },
  };
}
