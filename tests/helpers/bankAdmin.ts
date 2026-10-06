/** gRPC admin access to both Mock Banks (ports 50061 / 50062), section 16. */
import { callUnary, makeClient } from '@switch/common';
import { BankServiceClient, type ChaosConfig } from '@switch/proto-gen/bank/v1';

export type BankId = 'bank_a' | 'bank_b';
const TIMEOUT_MS = 5000;

const ADDRS: Record<BankId, string> = {
  bank_a: process.env.BANK_A_GRPC_ADDR ?? 'localhost:50061',
  bank_b: process.env.BANK_B_GRPC_ADDR ?? 'localhost:50062',
};

export class BankAdmin {
  private readonly clients: Record<BankId, BankServiceClient> = {
    bank_a: makeClient(BankServiceClient, ADDRS.bank_a),
    bank_b: makeClient(BankServiceClient, ADDRS.bank_b),
  };

  async createAccount(bank: BankId, accountId: string, balance: bigint, status = ''): Promise<void> {
    const c = this.clients[bank];
    await callUnary(
      c.createAccount.bind(c),
      { accountId, holderName: `Holder ${accountId}`, openingBalance: balance.toString(), currency: 'INR', status },
      { timeoutMs: TIMEOUT_MS },
    );
  }

  async balance(bank: BankId, accountId: string): Promise<bigint> {
    const c = this.clients[bank];
    return BigInt((await callUnary(c.getAccount.bind(c), { accountId }, { timeoutMs: TIMEOUT_MS })).balance);
  }

  async getChaos(bank: BankId): Promise<ChaosConfig> {
    const c = this.clients[bank];
    return callUnary(c.getChaosConfig.bind(c), {}, { timeoutMs: TIMEOUT_MS });
  }

  async setChaos(bank: BankId, config: ChaosConfig): Promise<ChaosConfig> {
    const c = this.clients[bank];
    return callUnary(c.setChaosConfig.bind(c), config, { timeoutMs: TIMEOUT_MS });
  }

  close(): void {
    for (const c of Object.values(this.clients)) c.close();
  }
}
