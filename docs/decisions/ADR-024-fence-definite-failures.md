# ADR-024 — A definite failure is final only once the reference is fenced

- **Status:** Accepted
- **Date:** 2026-10-07
- **Milestone:** post-M9 (found by the first `nightly` CI run)
- **Type:** Deviation (section 6: the saga calls `Resolve` before taking a definite-failure branch)

## Context

The first `nightly` run on GitHub Actions (run 37581136799, 10,000 transfers, `TEST_SEED=2`)
failed I2, I4 and I5. Transfer `b9bb6ea6` ended `FAILED / INSUFFICIENT_FUNDS`, yet the
payer's `DEBIT` at bank A was `APPLIED`. 41,693 paise left the payer and were never
credited or refunded. The Compose logs give the exact timeline:

| Time (UTC) | Event |
|---|---|
| 06:31:08.075 | `INITIATED -> DEBIT_SENT` |
| 06:31:10.076 | Debit attempt 1: deadline exceeded after 2 s, an unknown outcome. Chaos `late_apply` holds it for 3 s, then applies it |
| 06:31:10.142 | Debit attempt 2 (inline retry, same reference): `INSUFFICIENT_FUNDS`, a definite failure |
| 06:31:10.272 | `DEBIT_SENT -> FAILED` |
| about 06:31:11.08 | Attempt 1 runs. The payer had been credited in between, and the debit applies |

The cause is a gap in the specification, not a slip in the code. Section 8 says a business
rejection rolls back the whole transaction and leaves **no operation row**. The M2
acceptance test checks exactly that. So a rejection does not consume the
`(reference_id, operation)` key, and any earlier attempt still in flight for the same
reference can apply afterwards. Section 6 takes the failure branch on a definite answer
straight away. `Resolve` (ADR-002) fences a reference, but the spec uses it only to settle
*unknown* outcomes.

The credit leg has the same hole: a credit refused as `ACCOUNT_BLOCKED` or
`ACCOUNT_NOT_FOUND` sends the transfer to `REVERSING` and refunds the payer. If an earlier
credit attempt then lands (the account was unblocked or created), money is created. Two
integration tests reproduced both cases against the real stack before the fix: the late
request was `APPLIED`.

`late_apply` is not an artificial case. A request delayed in the network, or a bank that
is slow to dequeue, behaves exactly like this.

## Decision

**Fence before failing.** When a `Debit` or `Credit` gets a definite failure, the saga
calls `Resolve(reference_id = transfer id, operation)` on that bank before it takes the
failure branch:

| `Resolve` says | Then |
|---|---|
| `VOIDED` | The tombstone now makes any late attempt fail with `REFERENCE_VOIDED`. Take the failure branch (`FAILED` from `DEBIT_SENT`, `REVERSING` from `CREDIT_SENT`) with the bank's **original** failure code. The event detail records `fenced_by: Resolve`, `resolution: VOIDED` |
| `APPLIED` | An earlier attempt landed first, so the step succeeded. Post the leg journal and CAS to `DEBITED` / `CREDITED` (`*_CONFIRMED_BY_RESOLVE`), then carry on |
| no answer (unknown) | Stay in `*_SENT` and yield. An unfenced reference is never failed |
| a bug, or neither answer | `NEEDS_MANUAL_REVIEW` / `BANK_INVARIANT_VIOLATION`, as in `settle` |

The fence runs on **every** definite failure, not only after an observed timeout. Whether
an earlier attempt exists cannot be known reliably: it may have been sent by a driver that
crashed before it recorded anything. The one exception is `REFERENCE_VOIDED`
(`DEBIT_NOT_CONFIRMED` / `CREDIT_NOT_CONFIRMED`): that answer means the tombstone already
exists.

`settle` (the recovery path for unknown outcomes) and the new fence share one
implementation: `resolveLeg`, `onResolution` and `unresolved` in `domain/saga.ts`.

## Consequences

- Exactly-once holds when a late request races a rejection. The two integration tests
  (`failurePaths.test.ts`, "fenced against a late request") send a late `Debit` and a late
  `Credit` after the transfer is terminal, and require `REFERENCE_VOIDED` with balances
  unchanged. Seven unit tests cover the decision table above. A planted mutant that skips
  the fence fails 14 of them.
- Every transfer that fails or reverses on a bank refusal costs one extra `Resolve` call.
  In the chaos test that is about 5–6% of transfers (about 520 reversed and 15–84
  failed out of 10,000); with chaos off, only the genuine refusals pay it. A failed transfer now leaves a `VOIDED` tombstone at the
  bank. I5 already allows that ("none applied").
- If the bank cannot answer `Resolve`, a transfer that would have failed stays in
  `*_SENT` and is answered `202`. Recovery finishes it later. Correctness wins over the
  quick `422`, as for every other unknown outcome.
- The bank (an external system) is unchanged. The switch protects itself with the RPC the
  bank already offers.

## Alternatives considered

- **The bank records rejections as rows (status `REJECTED`), consuming the key.** It
  closes the hole at the source, but it changes the external bank's contract and schema
  and contradicts section 8 and the M2 acceptance test. A real bank would not change its
  API for one client, so the switch must cope with the API as it is.
- **Fence only after an observed unknown outcome in the same drive.** Cheaper, but
  incomplete: an attempt from a crashed driver leaves no trace in the current one.
- **Wait out `slow_ms` before failing.** Any wait is a guess about the network. The
  tombstone is a fact recorded by the bank's primary key.
