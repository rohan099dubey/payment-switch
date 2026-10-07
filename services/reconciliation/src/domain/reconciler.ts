import { classify, legKey, legOfJournal, type BreakType, type JournalView, type Leg, type LegOperation } from './legs';

/** One bank, as reconciliation sees it. */
export interface BankSide {
  /** The APPLIED operations created in `[from, to)`, page by page. */
  statement: (from: Date, to: Date) => AsyncIterable<Leg>;
  /** One operation by reference at any time; `null` when it is not APPLIED (absent or VOIDED). */
  operation: (referenceId: string, operation: LegOperation) => Promise<Leg | null>;
}

export interface LedgerSide {
  /** Journals created in `[from, to)`, page by page. */
  journals: (from: Date, to: Date) => AsyncIterable<JournalView>;
  /** Every journal carrying `referenceId`, at any time. */
  byReference: (referenceId: string) => Promise<JournalView[]>;
}

export interface BreakKey {
  bankId: string;
  referenceId: string;
  operation: LegOperation;
}

export interface FoundBreak extends BreakKey {
  type: BreakType;
  bankAmount: bigint | null;
  ledgerAmount: bigint | null;
}

export interface ReconStore {
  openBreaks: () => Promise<BreakKey[]>;
  /** Records breaks as OPEN; returns how many were new or reopened. */
  recordBreaks: (breaks: FoundBreak[]) => Promise<number>;
  /** Marks these keys RESOLVED where they are OPEN; returns how many changed. */
  resolve: (keys: BreakKey[]) => Promise<number>;
  countOpen: () => Promise<number>;
}

export interface ReconcileResult {
  statementLines: number;
  journals: number;
  breaksOpened: number;
  breaksResolved: number;
  openBreaks: number;
  found: FoundBreak[];
}

export interface ReconcilerDeps {
  banks: ReadonlyMap<string, BankSide>;
  ledger: LedgerSide;
  store: ReconStore;
  /** Parallel lookups of a missing side. */
  concurrency: number;
}

/** Sums each leg's amount: two journals for one leg are a break, not a match. */
function addLeg(map: Map<string, Leg>, leg: Leg): void {
  const key = legKey(leg);
  const existing = map.get(key);
  map.set(key, existing === undefined ? leg : { ...existing, amount: existing.amount + leg.amount });
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await fn(item);
      }
    }),
  );
}

/**
 * Section 19, item 3 (ADR-027): every leg seen in `[from, to)` on either side is matched by
 * (bank, reference, operation). A side missing from the window is then looked up by
 * reference at any time, so a leg straddling the window edge is never a false break. Open
 * breaks from earlier runs are re-checked and resolved once both sides agree.
 */
export class Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  async reconcile(from: Date, to: Date): Promise<ReconcileResult> {
    const { banks, ledger, store, concurrency } = this.deps;
    const bankLegs = new Map<string, Leg>();
    const ledgerLegs = new Map<string, Leg>();
    let statementLines = 0;
    let journals = 0;

    for (const side of banks.values()) {
      for await (const leg of side.statement(from, to)) {
        statementLines++;
        addLeg(bankLegs, leg);
      }
    }
    for await (const journal of ledger.journals(from, to)) {
      journals++;
      const leg = legOfJournal(journal);
      if (leg !== null) addLeg(ledgerLegs, leg);
    }

    const candidates = new Map<string, BreakKey>();
    for (const leg of [...bankLegs.values(), ...ledgerLegs.values()]) candidates.set(legKey(leg), leg);
    for (const key of await store.openBreaks()) candidates.set(legKey(key), key);

    // Fill each missing side by reference, at any time. One ledger lookup per reference.
    const ledgerByReference = new Map<string, Promise<Map<string, Leg>>>();
    const ledgerLegsFor = (referenceId: string): Promise<Map<string, Leg>> => {
      let pending = ledgerByReference.get(referenceId);
      if (pending === undefined) {
        pending = ledger.byReference(referenceId).then((list) => {
          const legs = new Map<string, Leg>();
          for (const journal of list) {
            const leg = legOfJournal(journal);
            if (leg !== null) addLeg(legs, leg);
          }
          return legs;
        });
        ledgerByReference.set(referenceId, pending);
      }
      return pending;
    };
    await mapLimit([...candidates.entries()], concurrency, async ([key, k]) => {
      // The window's sum may be partial (a duplicate journal outside it): always re-read by reference.
      const byRef = (await ledgerLegsFor(k.referenceId)).get(key);
      if (byRef === undefined) ledgerLegs.delete(key);
      else ledgerLegs.set(key, byRef);
      if (!bankLegs.has(key)) {
        const side = banks.get(k.bankId);
        const leg = side === undefined ? null : await side.operation(k.referenceId, k.operation);
        if (leg !== null) bankLegs.set(key, leg);
      }
    });

    const found: FoundBreak[] = [];
    const matched: BreakKey[] = [];
    for (const [key, k] of candidates) {
      const bank = bankLegs.get(key) ?? null;
      const led = ledgerLegs.get(key) ?? null;
      const type = classify(bank, led);
      const base = { bankId: k.bankId, referenceId: k.referenceId, operation: k.operation };
      if (type === null) matched.push(base);
      else found.push({ ...base, type, bankAmount: bank?.amount ?? null, ledgerAmount: led?.amount ?? null });
    }

    const breaksOpened = await store.recordBreaks(found);
    const breaksResolved = await store.resolve(matched);
    return { statementLines, journals, breaksOpened, breaksResolved, openBreaks: await store.countOpen(), found };
  }
}
