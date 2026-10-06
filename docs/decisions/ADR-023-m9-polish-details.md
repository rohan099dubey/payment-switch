# ADR-023 — M9 details: CI jobs, diagram rendering, readiness probes in `repo/`

- **Status:** Accepted
- **Date:** 2026-10-07
- **Milestone:** M9
- **Type:** Clarification (CI, documentation, one move of SQL into `repo/`)

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Where the jobs live | All three jobs in `.github/workflows/ci.yml`, which gains `schedule` (02:30 UTC daily) and `workflow_dispatch` triggers | §17 names one file with three jobs |
| Which events run which job | `static` on every event. `integration` (needs `static`) on `push` and `pull_request`. `nightly` (needs `static`) on `schedule` and `workflow_dispatch` | §17: `nightly` is "schedule and `workflow_dispatch`". It also waits for `static`, because a long run on a build that does not compile wastes the runner |
| Concurrency group | `ci-{event}-{ref}` instead of `ci-{ref}` | A scheduled run on `main` must not cancel a push to `main`, or be cancelled by one |
| Host build in the test jobs | `npm ci && npm run build` before `npm run stack:up` | The tests run on the runner and import the generated gRPC code and `@switch/common`. The images still build their own copy (`.dockerignore` keeps host artifacts out) |
| `integration` chaos step | `TRANSFER_COUNT=1000 npm run test:chaos`, exactly as §17 writes it. The chaos project includes the crash recovery test, so it runs here too | Verbatim |
| `nightly` | The 10,000-transfer test **twice**, `TEST_SEED=1` then `TEST_SEED=2`, then an unscoped `npm run invariants` | Stricter than "the full test" once: every night re-proves the definition-of-done item "passes twice in a row with different seeds". A CI stack is fresh, so the unscoped checker has no history to trip on (ADR-021) and checks the whole stack |
| Logs on failure | `docker compose logs --no-color --timestamps` into `compose-logs.txt`, uploaded with `actions/upload-artifact@v4` (14 days), only on failure; `npm run stack:down` with `if: always()` | §17 |
| Validating the workflow | `actionlint` (the `rhysd/actionlint` Docker image, which bundles shellcheck): 0 errors | There is no GitHub remote yet, so the jobs cannot run; this is the strongest check available locally |
| Clean-room check of the CI path | `COMPOSE_PROJECT_NAME=payment-switch-fresh` gives a throwaway project with its own empty volumes (the variable takes precedence over the file's `name:`). The development stack is `docker compose stop`ped (kept), the CI sequence runs on the fresh project, `docker compose -p payment-switch-fresh down -v --rmi local` removes it, and the development stack is started again | It runs what a CI runner runs, on empty databases, without resetting the development stack (that reset is the owner's decision, ADR-021) |
| Rendering diagrams | `@mermaid-js/mermaid-cli` 12.0.0 through `npx`, driving the locally installed Chrome (`PUPPETEER_SKIP_DOWNLOAD=1`, a puppeteer config with `executablePath`), white background, scale 2. The PNGs are committed next to the `.mmd` sources | Not a dependency in `package.json`: puppeteer would download a browser on every `npm ci`, CI included, for files that change rarely. The command is recorded below |
| Mermaid `#` | `Orchestrator #1` / `#2` renamed `Orchestrator 1 (inst1)` / `Orchestrator 2 (inst2)` in `sequence-crash-recovery.mmd` | `#` starts a comment in a Mermaid participant label, so both rendered as "Orchestrator" and the diagram lost its point (a second instance takes over) |
| Readiness probes | `ping(pool)` (`SELECT 1`) in `ledger/src/repo/balanceRepo.ts`, `mockBank/src/repo/accountsRepo.ts` and `orchestrator/src/repo/transfersRepo.ts`; each `main.ts` calls it for `/readyz` | §3: "SQL lives only in `repo/` files". The existing repo files are used, so the §3 file layout is unchanged |
| ADRs 001–008 | Left as written. Each gains an "As built" section naming the refining ADRs and the tests that prove it | An ADR records a decision at the time; refinements belong in their own ADRs, cross-referenced |

To re-render after editing a diagram (Chrome path as on the development machine):

```bash
echo '{"executablePath":"C:/Program Files/Google/Chrome/Application/chrome.exe","headless":"shell"}' > puppeteer.json
PUPPETEER_SKIP_DOWNLOAD=1 npx -y -p @mermaid-js/mermaid-cli@12.0.0 \
  mmdc -i docs/diagrams/state-machine.mmd -o docs/diagrams/state-machine.png -p puppeteer.json -b white -s 2
```

## Consequences

- Until the repository has a GitHub remote, the `integration` and `nightly` jobs are
  validated statically (actionlint), and their command sequence was run on a clean-room
  stack (2026-10-07): `stack:up` 9/9 healthy, seed 10 created then 0, integration
  179/179, `TRANSFER_COUNT=1000 test:chaos` 2/2, and the unscoped `npm run invariants`
  passing over all 1,265 transfers. The jobs themselves have never run on GitHub, so the
  definition-of-done item "tests pass in CI" stays unticked until they do.
- The nightly job takes roughly twice as long as one 10,000-transfer run; its timeout is
  120 minutes.
- Re-rendering a diagram is a manual step. A stale PNG would show in review, because the
  `.mmd` and `.png` change in the same commit.

## Alternatives considered

- **`nightly` runs the test once.** That is the literal §17 reading. Two seeds cost one
  more run and directly re-check the definition of done.
- **mermaid-cli as a devDependency with an `npm run diagrams` script.** It is
  reproducible, but it adds puppeteer and a browser download to every install.
- **GitHub's own Mermaid rendering in Markdown.** It only works on github.com, and §17
  asks for PNGs.
- **A new `repo/healthRepo.ts` per service.** It is cleaner in isolation, but it adds
  files that §3's layout does not list.
