/**
 * `npm run seed`: creates the demo accounts the README quick start uses.
 * `npm run seed -- --load`: creates the load-test accounts `L0001`–`L0200` on each bank,
 * 1,000,000,000 paise each (section 16, load test).
 *
 * Idempotent: an account that already exists is reported and left untouched (its balance
 * is never reset, because that would create money outside the ledger).
 */
import { status as Status } from '@grpc/grpc-js';
import { isGrpcError } from '@switch/common';
import { BankAdmin, type BankId } from '../tests/helpers/bankAdmin';

interface Plan {
  label: string;
  ids: string[];
  openingBalance: bigint;
}

/** README quick start: `ACC001`–`ACC005` on each bank, ₹1,00,000 (10,000,000 paise) each. */
const DEMO: Plan = {
  label: 'demo',
  ids: Array.from({ length: 5 }, (_, i) => `ACC${String(i + 1).padStart(3, '0')}`),
  openingBalance: 10_000_000n,
};

/** Section 16: `L0001`–`L0200` per bank, 1,000,000,000 paise each. */
const LOAD: Plan = {
  label: 'load',
  ids: Array.from({ length: 200 }, (_, i) => `L${String(i + 1).padStart(4, '0')}`),
  openingBalance: 1_000_000_000n,
};

async function main(): Promise<number> {
  const plan = process.argv.includes('--load') ? LOAD : DEMO;
  const banks = new BankAdmin();
  let created = 0;
  let existing = 0;
  try {
    for (const bank of ['bank_a', 'bank_b'] as BankId[]) {
      for (const id of plan.ids) {
        try {
          await banks.createAccount(bank, id, plan.openingBalance);
          created++;
        } catch (err) {
          if (!isGrpcError(err) || err.code !== Status.ALREADY_EXISTS) throw err;
          existing++;
        }
      }
    }
  } finally {
    banks.close();
  }
  const first = plan.ids[0] ?? '';
  const last = plan.ids.at(-1) ?? '';
  process.stdout.write(
    `${plan.label} accounts ${first}-${last} on bank_a and bank_b: ${created} created, ${existing} already existed (left untouched)\n`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`seed failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
