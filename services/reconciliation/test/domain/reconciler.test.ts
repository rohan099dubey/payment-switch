import { describe, expect, it } from 'vitest';
import { classify, legKey, legOfJournal, type JournalView, type Leg, type LegOperation } from '../../src/domain/legs';
import {
  Reconciler,
  type BankSide,
  type BreakKey,
  type FoundBreak,
  type LedgerSide,
  type ReconStore,
} from '../../src/domain/reconciler';

const T0 = new Date('2026-10-07T10:00:00Z');
const T1 = new Date('2026-10-07T10:05:00Z');

const debitLeg = (ref: string, amount: bigint, bank = 'bank_a'): JournalView => ({
  referenceId: ref,
  kind: 'TRANSFER_DEBIT_LEG',
  lines: [
    { accountCode: `receivable:${bank}`, direction: 'DEBIT', amount },
    { accountCode: 'transit', direction: 'CREDIT', amount },
  ],
});
const creditLeg = (ref: string, amount: bigint, bank = 'bank_b'): JournalView => ({
  referenceId: ref,
  kind: 'TRANSFER_CREDIT_LEG',
  lines: [
    { accountCode: 'transit', direction: 'DEBIT', amount },
    { accountCode: `payable:${bank}`, direction: 'CREDIT', amount },
  ],
});
const reversal = (ref: string, amount: bigint, bank = 'bank_a'): JournalView => ({
  referenceId: ref,
  kind: 'TRANSFER_REVERSAL',
  lines: [
    { accountCode: 'transit', direction: 'DEBIT', amount },
    { accountCode: `receivable:${bank}`, direction: 'CREDIT', amount },
  ],
});
const op = (bankId: string, referenceId: string, operation: LegOperation, amount: bigint): Leg => ({
  bankId,
  referenceId,
  operation,
  amount,
});

describe('legOfJournal and classify (ADR-027)', () => {
  it('maps each transfer journal kind to the bank leg it records', () => {
    expect(legOfJournal(debitLeg('r', 100n))).toEqual(op('bank_a', 'r', 'DEBIT', 100n));
    expect(legOfJournal(creditLeg('r', 100n))).toEqual(op('bank_b', 'r', 'CREDIT', 100n));
    expect(legOfJournal(reversal('r', 100n))).toEqual(op('bank_a', 'r', 'REVERSE_DEBIT', 100n));
    expect(legOfJournal({ referenceId: 'r', kind: 'MANUAL_ADJUSTMENT', lines: [] })).toBeNull();
  });

  it('classifies the three break types, and agreement as no break', () => {
    const a = op('bank_a', 'r', 'DEBIT', 100n);
    expect(classify(a, a)).toBeNull();
    expect(classify(a, null)).toBe('MISSING_IN_LEDGER');
    expect(classify(null, a)).toBe('MISSING_AT_BANK');
    expect(classify(a, { ...a, amount: 99n })).toBe('AMOUNT_MISMATCH');
  });
});

/** In-memory books on both sides, with what falls inside the window marked separately. */
class World {
  readonly bankOps = new Map<string, Leg[]>(); // all operations, by bank
  readonly inWindow = new Set<Leg | JournalView>();
  readonly journals: JournalView[] = [];

  bank(bankId: string, leg: Leg, inWindow = true): void {
    this.bankOps.set(bankId, [...(this.bankOps.get(bankId) ?? []), leg]);
    if (inWindow) this.inWindow.add(leg);
  }

  journal(j: JournalView, inWindow = true): void {
    this.journals.push(j);
    if (inWindow) this.inWindow.add(j);
  }

  banks(): Map<string, BankSide> {
    const out = new Map<string, BankSide>();
    for (const bankId of ['bank_a', 'bank_b']) {
      const ops = (): Leg[] => this.bankOps.get(bankId) ?? [];
      out.set(bankId, {
        statement: () => iterate(ops().filter((leg) => this.inWindow.has(leg))),
        operation: (ref, operation) =>
          Promise.resolve(ops().find((l) => l.referenceId === ref && l.operation === operation) ?? null),
      });
    }
    return out;
  }

  ledger(): LedgerSide {
    return {
      journals: () => iterate(this.journals.filter((j) => this.inWindow.has(j))),
      byReference: (ref) => Promise.resolve(this.journals.filter((j) => j.referenceId === ref)),
    };
  }
}

/** An async iterable over a fixed list (the ports page lazily; the fakes need not). */
function iterate<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: (): Promise<IteratorResult<T>> => {
          const item = items[i++];
          return Promise.resolve(item === undefined ? { value: undefined, done: true } : { value: item, done: false });
        },
      };
    },
  };
}

class FakeStore implements ReconStore {
  readonly breaks = new Map<string, FoundBreak & { status: 'OPEN' | 'RESOLVED' }>();
  openBreaks(): Promise<BreakKey[]> {
    return Promise.resolve([...this.breaks.values()].filter((b) => b.status === 'OPEN'));
  }
  recordBreaks(found: FoundBreak[]): Promise<number> {
    let opened = 0;
    for (const b of found) {
      const prev = this.breaks.get(legKey(b));
      if (prev === undefined || prev.status === 'RESOLVED') opened++;
      this.breaks.set(legKey(b), { ...b, status: 'OPEN' });
    }
    return Promise.resolve(opened);
  }
  resolve(keys: BreakKey[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      const b = this.breaks.get(legKey(k));
      if (b?.status === 'OPEN') {
        b.status = 'RESOLVED';
        n++;
      }
    }
    return Promise.resolve(n);
  }
  countOpen(): Promise<number> {
    return Promise.resolve([...this.breaks.values()].filter((b) => b.status === 'OPEN').length);
  }
}

function reconciler(
  world: World,
  store = new FakeStore(),
): { store: FakeStore; run: () => ReturnType<Reconciler['reconcile']> } {
  const r = new Reconciler({ banks: world.banks(), ledger: world.ledger(), store, concurrency: 4 });
  return { store, run: () => r.reconcile(T0, T1) };
}

describe('Reconciler (section 19, ADR-027)', () => {
  it('a complete transfer (debit, credit and their journals) has no break', async () => {
    const w = new World();
    w.bank('bank_a', op('bank_a', 't1', 'DEBIT', 500n));
    w.bank('bank_b', op('bank_b', 't1', 'CREDIT', 500n));
    w.journal(debitLeg('t1', 500n));
    w.journal(creditLeg('t1', 500n));
    const result = await reconciler(w).run();
    expect(result).toMatchObject({ statementLines: 2, journals: 2, breaksOpened: 0, openBreaks: 0 });
  });

  it('a reversed transfer (debit, reverse debit, debit leg, reversal) has no break', async () => {
    const w = new World();
    w.bank('bank_a', op('bank_a', 't1', 'DEBIT', 500n));
    w.bank('bank_a', op('bank_a', 't1', 'REVERSE_DEBIT', 500n));
    w.journal(debitLeg('t1', 500n));
    w.journal(reversal('t1', 500n));
    expect((await reconciler(w).run()).found).toEqual([]);
  });

  it('finds each break type with both amounts', async () => {
    const w = new World();
    w.bank('bank_a', op('bank_a', 'only-bank', 'DEBIT', 100n));
    w.journal(creditLeg('only-ledger', 200n));
    w.bank('bank_a', op('bank_a', 'mismatch', 'DEBIT', 300n));
    w.journal(debitLeg('mismatch', 299n));
    const { found } = await reconciler(w).run();
    expect(found.sort((a, b) => a.referenceId.localeCompare(b.referenceId))).toEqual([
      {
        bankId: 'bank_a',
        referenceId: 'mismatch',
        operation: 'DEBIT',
        type: 'AMOUNT_MISMATCH',
        bankAmount: 300n,
        ledgerAmount: 299n,
      },
      {
        bankId: 'bank_a',
        referenceId: 'only-bank',
        operation: 'DEBIT',
        type: 'MISSING_IN_LEDGER',
        bankAmount: 100n,
        ledgerAmount: null,
      },
      {
        bankId: 'bank_b',
        referenceId: 'only-ledger',
        operation: 'CREDIT',
        type: 'MISSING_AT_BANK',
        bankAmount: null,
        ledgerAmount: 200n,
      },
    ]);
  });

  it('a leg straddling the window edge is matched by reference, not reported', async () => {
    const w = new World();
    w.bank('bank_a', op('bank_a', 'edge', 'DEBIT', 100n)); // inside the window
    w.journal(debitLeg('edge', 100n), false); // posted just after it closed
    w.journal(creditLeg('edge2', 50n)); // inside
    w.bank('bank_b', op('bank_b', 'edge2', 'CREDIT', 50n), false); // applied just before it opened
    expect((await reconciler(w).run()).found).toEqual([]);
  });

  it('two journals for one leg are an amount mismatch, not a match', async () => {
    const w = new World();
    w.bank('bank_a', op('bank_a', 'dup', 'DEBIT', 100n));
    w.journal(debitLeg('dup', 100n));
    w.journal(debitLeg('dup', 100n), false); // the duplicate sits outside the window
    const { found } = await reconciler(w).run();
    expect(found).toEqual([
      {
        bankId: 'bank_a',
        referenceId: 'dup',
        operation: 'DEBIT',
        type: 'AMOUNT_MISMATCH',
        bankAmount: 100n,
        ledgerAmount: 200n,
      },
    ]);
  });

  it('a journal naming a bank the service does not know is missing at bank', async () => {
    const w = new World();
    w.journal(debitLeg('x', 100n, 'bank_zz'));
    expect((await reconciler(w).run()).found[0]).toMatchObject({ bankId: 'bank_zz', type: 'MISSING_AT_BANK' });
  });

  it('an open break is re-checked every run: resolved once both sides agree, reopened if it breaks again', async () => {
    const w = new World();
    w.bank('bank_a', op('bank_a', 'late', 'DEBIT', 100n));
    const { store, run } = reconciler(w);
    expect((await run()).breaksOpened).toBe(1);

    // Recovery posts the journal later, outside any reconciled window.
    w.inWindow.clear();
    w.journal(debitLeg('late', 100n), false);
    const second = await run();
    expect(second).toMatchObject({ breaksResolved: 1, openBreaks: 0 });
    expect(store.breaks.get('bank_a|late|DEBIT')?.status).toBe('RESOLVED');

    // A breaking change later (a duplicate journal) reopens it.
    w.journal(debitLeg('late', 100n));
    expect((await run()).breaksOpened).toBe(1);
  });
});
