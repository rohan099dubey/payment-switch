import { callUnary, makeClient } from '@switch/common';
import { BankServiceClient, OperationStatus, type MoneyOperationResponse } from '@switch/proto-gen/bank/v1';
import type { BankPort, BankReceipt, CallOptions } from '../domain/saga';
import type { Transfer } from '../domain/transfer';

/** One `BankServiceClient` per `bank_id` in `BANK_ENDPOINTS` (spec section 6). */
export class BankClients {
  private readonly clients: ReadonlyMap<string, BankServiceClient>;

  constructor(
    endpoints: ReadonlyMap<string, string>,
    factory: (address: string) => BankServiceClient = (address) => makeClient(BankServiceClient, address),
  ) {
    this.clients = new Map([...endpoints].map(([bankId, address]) => [bankId, factory(address)]));
  }

  has(bankId: string): boolean {
    return this.clients.has(bankId);
  }

  get bankIds(): string[] {
    return [...this.clients.keys()];
  }

  /** @throws Error for a bank id not in `BANK_ENDPOINTS`; `CreateTransfer` validation rules that out. */
  get(bankId: string): BankServiceClient {
    const client = this.clients.get(bankId);
    if (client === undefined) throw new Error(`no endpoint configured for bank ${bankId}`);
    return client;
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
  }
}

function receipt(response: MoneyOperationResponse): BankReceipt {
  return { bankTxnId: response.bankTxnId, applied: response.status === OperationStatus.OPERATION_STATUS_APPLIED };
}

/**
 * The saga's view of the banks. Reference id is always the transfer id, so a retry,
 * a crash replay or a second driver sends the identical idempotent request.
 */
export function createBankPort(banks: BankClients): BankPort {
  return {
    debit: async (t: Transfer, options: CallOptions) => {
      const client = banks.get(t.payer.bankId);
      const request = {
        referenceId: t.id,
        accountId: t.payer.accountId,
        amount: t.amount.toString(),
        currency: t.currency,
      };
      return receipt(await callUnary(client.debit.bind(client), request, options));
    },
    credit: async (t: Transfer, options: CallOptions) => {
      const client = banks.get(t.payee.bankId);
      const request = {
        referenceId: t.id,
        accountId: t.payee.accountId,
        amount: t.amount.toString(),
        currency: t.currency,
      };
      return receipt(await callUnary(client.credit.bind(client), request, options));
    },
    reverseDebit: async (t: Transfer, options: CallOptions) => {
      const client = banks.get(t.payer.bankId);
      return receipt(await callUnary(client.reverseDebit.bind(client), { referenceId: t.id }, options));
    },
  };
}
