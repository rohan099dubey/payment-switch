/** gRPC read access to the Ledger (port 50052): section 16 helper. */
import { callUnary, makeClient } from '@switch/common';
import { EntryDirection, LedgerServiceClient } from '@switch/proto-gen/ledger/v1';

const TIMEOUT_MS = 10_000;

export interface JournalView {
  kind: string;
  lines: { accountCode: string; direction: 'D' | 'C'; amount: bigint }[];
}

export class LedgerReader {
  private readonly client = makeClient(LedgerServiceClient, process.env.LEDGER_GRPC_ADDR ?? 'localhost:50052');

  async getTrialBalance(): Promise<{ balanced: boolean; balances: Map<string, bigint> }> {
    const c = this.client;
    const t = await callUnary(c.getTrialBalance.bind(c), {}, { timeoutMs: TIMEOUT_MS });
    return { balanced: t.balanced, balances: new Map(t.accounts.map((a) => [a.accountCode, BigInt(a.balance)])) };
  }

  async getBalance(accountCode: string): Promise<bigint> {
    const c = this.client;
    return BigInt((await callUnary(c.getBalance.bind(c), { accountCode }, { timeoutMs: TIMEOUT_MS })).balance);
  }

  async listJournals(referenceId: string): Promise<JournalView[]> {
    const c = this.client;
    const res = await callUnary(c.listJournals.bind(c), { referenceId }, { timeoutMs: TIMEOUT_MS });
    return res.journals.map((j) => ({
      kind: j.kind,
      lines: j.lines.map((l) => ({
        accountCode: l.accountCode,
        direction: l.direction === EntryDirection.ENTRY_DIRECTION_DEBIT ? ('D' as const) : ('C' as const),
        amount: BigInt(l.amount),
      })),
    }));
  }

  close(): void {
    this.client.close();
  }
}
