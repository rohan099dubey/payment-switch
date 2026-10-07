/** gRPC admin access to both Mock Banks (ports 50061 / 50062), section 16. */
import { callUnary, errorCodeOf, makeClient } from '@switch/common';
import { BankServiceClient, OperationStatus, OperationType, type ChaosConfig } from '@switch/proto-gen/bank/v1';

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

  async getOperation(
    bank: BankId,
    referenceId: string,
    operation: 'DEBIT' | 'CREDIT' | 'REVERSE_DEBIT',
  ): Promise<{ status: 'APPLIED' | 'VOIDED' | 'NOT_FOUND'; amount: bigint }> {
    const c = this.clients[bank];
    const type =
      operation === 'DEBIT'
        ? OperationType.OPERATION_TYPE_DEBIT
        : operation === 'CREDIT'
          ? OperationType.OPERATION_TYPE_CREDIT
          : OperationType.OPERATION_TYPE_REVERSE_DEBIT;
    const res = await callUnary(c.getOperation.bind(c), { referenceId, operation: type }, { timeoutMs: TIMEOUT_MS });
    const status =
      res.status === OperationStatus.OPERATION_STATUS_APPLIED
        ? 'APPLIED'
        : res.status === OperationStatus.OPERATION_STATUS_VOIDED
          ? 'VOIDED'
          : 'NOT_FOUND';
    return { status, amount: BigInt(res.amount) };
  }

  /**
   * A raw `Debit` or `Credit`, as the Orchestrator would send it. Tests use it to play a
   * request that arrives late, after the switch already decided the transfer. Resolves
   * to `APPLIED` or to the bank's `x-error-code`.
   */
  async sendMoney(
    bank: BankId,
    operation: 'debit' | 'credit',
    referenceId: string,
    accountId: string,
    amount: bigint,
  ): Promise<string> {
    const c = this.clients[bank];
    const call = operation === 'debit' ? c.debit.bind(c) : c.credit.bind(c);
    try {
      const res = await callUnary(
        call,
        { referenceId, accountId, amount: amount.toString(), currency: 'INR' },
        { timeoutMs: TIMEOUT_MS },
      );
      return res.status === OperationStatus.OPERATION_STATUS_APPLIED ? 'APPLIED' : `status ${res.status}`;
    } catch (err) {
      return errorCodeOf(err) ?? String(err);
    }
  }

  /** `Resolve`: writes a VOIDED tombstone unless the operation already applied. */
  async resolve(bank: BankId, referenceId: string, operation: 'DEBIT' | 'CREDIT'): Promise<'APPLIED' | 'VOIDED'> {
    const c = this.clients[bank];
    const res = await callUnary(
      c.resolve.bind(c),
      {
        referenceId,
        operation: operation === 'DEBIT' ? OperationType.OPERATION_TYPE_DEBIT : OperationType.OPERATION_TYPE_CREDIT,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    return res.status === OperationStatus.OPERATION_STATUS_APPLIED ? 'APPLIED' : 'VOIDED';
  }

  /** Back to the defaults docker-compose.yml starts the banks with: no chaos. */
  async clearChaos(bank: BankId): Promise<void> {
    await this.setChaos(bank, {
      down: false,
      latencyMinMs: 0,
      latencyMaxMs: 0,
      rejectRate: 0,
      lateApplyRate: 0,
      lostResponseRate: 0,
      slowMs: 3000,
      seed: 42,
    });
  }

  close(): void {
    for (const c of Object.values(this.clients)) c.close();
  }
}
