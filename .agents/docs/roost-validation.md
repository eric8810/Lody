# Roost validation workflow

Use this workflow for Lody's Roost integration and its matching Roost SDK/Native
changes. It fixes setup, owning suites and comparison workloads so a new change
does not require rediscovering them. Runtime contracts remain in
[session rules](../../apps/cli/src/session/AGENTS.md) and the matching Roost source.
Run expensive measurements manually; timing is never a CI assertion.

## Prepare once per source revision

Use separate source clones with their own dependency directories for baseline
and candidate. Record both repository SHAs, uncommitted runtime diffs, Node
version, platform/architecture, package-manager versions and loaded SDK/Native
paths. A branch name or unchanged package version does not identify a candidate.
Use synthetic data in fresh directories; do not point a benchmark at live state.

Install Lody from its root with `corepack pnpm install --frozen-lockfile`, following
the root runtime floor. Run `corepack pnpm run docs status` once at task start.
For published dependencies, the lockfile is the source of truth. For an unreleased
matching SDK, prepare Roost in **its own package directories**:

```sh
cd "$ROOST_CHECKOUT/ts"
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm build
cd "$ROOST_CHECKOUT/node/native"
corepack pnpm install --frozen-lockfile
RUSTUP_TOOLCHAIN=stable corepack pnpm build
```

Roost has no root `package.json`; running pnpm at its root can select the wrong
pnpm version. Reuse an existing addon only when Rust, Native glue and build
inputs are unchanged; record its hash. Use Roost's `ts` `pack:consumer` and Native
`release:prepare`/`release:check` for package verification rather than inventing
another packaging process. Rebuilding an unchanged addon is unnecessary.

In an isolated Lody clone, an unreleased source pair may replace only its CLI
dependency symlinks with the corresponding built Roost packages. Confirm each
path is a symlink before replacing it; retain the old target for restoration.
Do not write through pnpm-store links or another checkout's scope directories.
If using an archived research workspace, `node_modules/@lody` itself may point
outside that workspace: use an isolated dependency tree instead of changing its
children. The loaded `@lody/shared` must resolve to the measured Lody revision.

From `apps/cli`, verify the resolved pair before testing:

```sh
node --input-type=module -e 'for (const s of ["@loro-dev/roost/lody-history", "@loro-dev/roost-node", "@loro-dev/roost-node/native", "@lody/shared"]) console.log(s, import.meta.resolve(s))'
```

Capture resolved files and hashes with the result. Never set
`NAPI_RS_NATIVE_LIBRARY_PATH` globally: it also overrides unrelated napi-rs tools.
If needed, scope it to one Native test/benchmark command. A local source link
does not make published dependency CI green; release and pin the matching SDK
before removing that release blocker.

## Select checks from the changed boundary

During iteration, run the owning row below. After a fix, rerun its failed case and
owning suite; do not restart completed unrelated suites. Run Lody's required
root `corepack pnpm check` and `corepack pnpm format` once before committing, then
`corepack pnpm run docs check`. Subsequent documentation-only edits need docs and
format checks, not another complete runtime run.

| Change                                                  | Owning checks                                                                                                                                                 | Additional evidence when relevant                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Text notification semantics / immutable plans           | CLI `acp-apply-notification-on-history.test.ts`                                                                                                               | Split Unicode, prompt markers, thinking/plan tags, snapshot/overlap behavior, malformed stored scalars, caller mutation      |
| History actions / state projection                      | Shared `session-history-actions.test.ts`; CLI `roost-message-state.test.ts`                                                                                   | Finish/permission semantics, borrowed snapshot ownership, bounded resumed-state programs, Native scalar offsets and own keys |
| Lody commit, projection, receipt or branch behavior     | CLI `roost-session-backend-contract.test.ts`, `roost-history-local-writes.test.ts`, `roost-history-local-branch.test.ts`, `roost-history-local-owner.test.ts` | Retry/lost reply, foreign/pending events, reopen, reader ownership, pagination and retained overlays                         |
| SDK history/checkpoint/index behavior                   | Roost `ts` type/build; Native `tests/native.test.mjs`; SDK `lody-history.test.mjs` and `node-history-index.test.mjs`                                          | Browser IndexedDB and Native/process paths; copied/altered proof, stale CAS, non-applied derived group                       |
| Rust storage, events, transaction or signature behavior | Matching Roost Rust integration suites, fmt and clippy; Native integration                                                                                    | Crash/reopen, export identity, partial replica, seal/owner/sequence rules; rebuild addon                                     |
| Packed consumer or release layout                       | Existing Roost consumer/release checks and platform CI                                                                                                        | Installed tarball, optional platform package and supported Node floor                                                        |
| Performance-sensitive path                              | Owning correctness suites, then one applicable manual benchmark below                                                                                         | Same host, workload, durability, read-consumer behavior and source hashes                                                    |

Run the CLI suites from `apps/cli`:

```sh
corepack pnpm exec vitest run tests/acp-apply-notification-on-history.test.ts
corepack pnpm exec vitest run tests/roost-session-backend-contract.test.ts tests/roost-history-local-writes.test.ts tests/roost-history-local-branch.test.ts tests/roost-history-local-owner.test.ts --maxWorkers=2
```

Run SDK history suites from Roost's `ts` after building. On a constrained host,
serialize browser files; the existing test-name filter selects the browser:

Install Chromium/WebKit once with `corepack pnpm exec playwright install chromium webkit`
in `ts` if absent. For the process cases, build `cargo +stable build --locked --bin
roost-node-owner` at Roost's root when no matching binary exists. A missing binary
skips those cases; check the reported skip count rather than counting them as passes.

```sh
node --test --test-concurrency=1 --test-name-pattern='chromium' tests/lody-history.test.mjs
node --test --test-concurrency=1 tests/node-history-index.test.mjs
node --test --test-concurrency=1 --test-name-pattern='webkit' tests/lody-history.test.mjs
```

Run `node --test tests/native.test.mjs` from Roost's `node/native` with the matching
SDK built. It requires the addon; subprocess-only tests use the matching owner
binary. Follow that checkout's Native README/CI for Rust and package checks.

## Choose a fixed manual benchmark

All entries below run from `apps/cli`. Existing `.mts` entries use:

```sh
TSX_TSCONFIG_PATH=tsconfig.json node --experimental-wasm-modules --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-send.mts
```

Replace the filename for the other `.mts` entries and use their documented
`BENCH_*` options. Do not compare their numbers across different scopes:

| Entry                                                                      | Question / fixed case                                                                                     | Durability and excluded costs                                                                                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`roost-send.mts`](../../apps/cli/benchmarks/roost-send.mts)               | First input + three follow-ups; 9 samples, 2 warmups; `BENCH_DISPATCH=1` includes activation              | Roost durable; Loro in memory. No network, Agent execution or renderer                                                               |
| [`roost-first-input.mts`](../../apps/cli/benchmarks/roost-first-input.mts) | Cold open / first input after 0, 100, 1000 messages; same `BENCH_DIR`, `BENCH_PHASE=prepare` then measure | Roost durable; Loro snapshot restored into memory. File cache may be warm                                                            |
| [`roost-history.mts`](../../apps/cli/benchmarks/roost-history.mts)         | Windowed reads at 100, 1000, 10000 messages; 4 KiB bodies; `BENCH_STRUCTURAL=1` adds structural work      | Production backends + ConversationView. No renderer transport, IndexedDB or paint                                                    |
| [`roost-durable.test.ts`](../../apps/cli/benchmarks/roost-durable.test.ts) | Durable growing history and growing reply; explicit write → fresh-process reopen → paging                 | Both sides SQLite WAL/FULL and control persistence after every action; live incremental reader measured separately. No network or UI |
| [`roost-dispatch.test.ts`](../../apps/cli/benchmarks/roost-dispatch.test.ts) | Fixed 100/1,000/10,000-message prefixes, actual watcher selection, 20 appends and fresh-process verification | Both sides SQLite WAL/FULL plus per-action control persistence; selected boundary excludes ACP execution, transport and renderer |

The durable harness has an explicit opt-in config, excluded from default CI.
Set an absolute, fresh `BENCH_DIR` outside the source checkout. Use the same
commands/parameters in each measured source checkout, changing only its output
directory. This example is the **many-message** case:

```sh
export BENCH_DIR=/absolute/path/to/a/new-benchmark-run
(
set -e
for kind in roost loro; do
  for stage in write reopen paging; do
    LONG_BENCH_DIR="$BENCH_DIR/$kind" LONG_BENCH_KIND="$kind" \
      LONG_BENCH_STAGE="$stage" LONG_BENCH_ROUNDS=100 \
      LONG_BENCH_CHUNKS=20 LONG_BENCH_CHUNK_BYTES=256 LONG_BENCH_TOOL_BYTES=16384 \
      corepack pnpm exec vitest run --config benchmarks/vitest.durable.config.ts
  done
done
)
```

The **growing-reply** case uses `ROUNDS=1`, `CHUNKS=1000`, `CHUNK_BYTES=1024`,
`TOOL_BYTES=16384` with the same `LONG_BENCH_` prefixes. Use another fresh output
directory. Start each stage in its own process; the installed Native backend is
process-wide, so changing its database options within a reused process is invalid.
Keep coordinator logs and source manifests outside `LONG_BENCH_DIR`: the write
stage requires an empty data directory and refuses pre-existing files.
The **mixed/resumed** case sets `LONG_BENCH_MIXED=1`, `ROUNDS=10`, `CHUNKS=100`,
`CHUNK_BYTES=1024`, `TOOL_BYTES=16384`. It includes a fragmented thinking block,
Unicode, tool/plan changes, and a durable finish/reopen halfway through each reply.
The `resume` metric includes that finish/open pair and both persistence barriers;
chunk latency includes later writes to the resumed state. Its expected business
content comes from the established mutating reducer, and includes the final plan.
Use identical deterministic fixtures; do not include fixture generation, builds
or other tests in the timed interval. Run baseline/candidate in an A–B–B–A order
when reporting a speed change. Record the shared reducer revision used by Loro.
Larger cases are opt-in and must state their parameters rather than silently
replacing the standard workloads.

After the three stages for both backends, verify the persisted results:

```sh
python3 - <<'PY_CHECK'
import json, os, pathlib, sqlite3
root = pathlib.Path(os.environ['BENCH_DIR'])
digests = set()
for kind in ['roost', 'loro']:
    read = lambda name: json.loads((root / kind / (name + '.json')).read_text())
    write, reopen = read('write'), read('reopen')
    assert write['fullDigest'] == reopen['fullDigest'], kind
    digests.add(write['canonicalContentDigest'])
assert len(digests) == 1
for path in root.glob('*/*.db'):
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as db:
        assert db.execute('pragma quick_check').fetchall() == [('ok',)], path
print('Reopen, cross-backend content and SQLite checks passed')
PY_CHECK
```

### Fixed-prefix dispatch

Use the same opt-in config with `LONG_BENCH_DISPATCH=1`. For each backend and
prefix of 100, 1,000 and 10,000 **logical messages**, run `prepare` in a fresh
synthetic directory. It imports a completed alternating prefix (half as many
rounds), appends one pending user and one open assistant, and records initial
index repair separately. All assistants have 1 KiB text and 16 KiB tool output;
users have 256 bytes. The measured count initially equals prefix + 2.

```sh
LONG_BENCH_DISPATCH=1 LONG_BENCH_DIR="$BENCH_DIR/roost-1000" \
  LONG_BENCH_KIND=roost LONG_BENCH_PREFIX=1000 LONG_BENCH_STAGE=prepare \
  corepack pnpm exec vitest run --config benchmarks/vitest.durable.config.ts
```

Close preparation completely. Copy its database directory into a new trial
directory, then run `measure` followed by `verify`, each in a fresh process with
the same environment except `LONG_BENCH_DIR` and `LONG_BENCH_STAGE`. Use the same
prepared Roost seed for baseline/candidate A–B–B–A trials and a Loro seed with
identical business content. Record the exact overlaid sources and dependency
paths, and restore any archived research workspace in `finally`.

The measurement invokes the real watcher's history/queue selection 13 times
(first + 12 warm); agent execution, access checks and steer reconciliation are
excluded. It then records 20 primary 256-byte notification appends, finish,
resume, the first resumed append, user/assistant creation, selected old-turn and
adjacent-page reads. Every mutation includes explicit control persistence, with
acknowledgment and persistence timings also retained separately. Same-operation
retry must not duplicate output. Memory samples precede full export and follow
each phase; full-content verification and a fresh-process digest check run after
timing. SQLite `quick_check` remains an external, post-close check.

`openMs` covers persisted-document loading, composition and backend creation;
it stops before backend initialization, transport sync, agent restoration and
visible UI. `warmDispatch` follows that loading, and the write metric `resume`
only reopens an assistant history entry. Neither is long-session recovery.
The prefix imports final turns rather than generating their full streaming edit
sequences: matching final content does not match CRDT operation history.

Do not describe this as full session recovery, full agent-response latency, a
network test, a growing 1 MiB reply test, or the cost of a cold OS page cache. The
[dispatch report](../notes/proposed/architecture/2026-10-22-roost-dispatch-scalar-projection.md#validation-and-limits)
records results and missing categories.

## Report contract

Every benchmark handoff includes a human-readable report in the owning bilingual
Agent Note, linked from the PR and this guide. Raw JSON alone is insufficient.
Use the same rows for baseline, candidate and Loro; show regressions and missing
measurements alongside improvements. A narrow probe may mark unrelated rows
`not measured`, but cannot establish overall or long-conversation performance.
The [completed incremental-mutation report](../notes/proposed/architecture/2026-10-22-roost-end-to-end-incremental-mutations.md#complete-resource-report)
is the current example, including its measurement gaps and read-path interpretation.

| Dimension                | Required report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workload and ownership   | Exact revisions/binaries, host/runtime, durability, warm/cold state, logical messages **and** rounds, body/tool bytes, chunks and sizes, loaded window/cache bounds, trial order/count, consumers and exclusions. A 1 MiB reply and 10,000 historical messages answer different questions.                                                                                                                                                                                                                   |
| History scaling          | For a claim about long-history structure, cover fixed prefixes of 100, 1,000 and 10,000 messages (or report an explicit supported limit/failure), keeping current-message size and measured operations fixed. Report prefix preparation separately. Growing-history aggregate p95 is not p95 at its final size.                                                                                                                                                                                              |
| Reply scaling            | Keep historical count fixed and measure growth through at least 64/256/1,024 KiB where supported. Separate primary streaming, thought/tag rewrites, tool insertion/update, plan update and resumed-state append. Mixed-batch timing cannot identify each operation's cost.                                                                                                                                                                                                                                   |
| Writes                   | Per category: sample count, p50/p95/max for user creation, assistant creation, text/thought append, tool/plan update, finish/seal, resume and the first/subsequent resumed append. Show local acknowledgment, control persistence and visible-consumer latency separately when measured. Pooled user/assistant creation must be labeled pooled.                                                                                                                                                              |
| Memory growth            | RSS at post-import process start, after backend open, after latest-window hydration, at every reported history/body-size milestone, before full export/validation, after full materialization, and after release where measured. Include JS heap, external and array-buffer samples with phase labels. Show growth from a common opened baseline and an actual trajectory, not only one peak. Label whole-process RSS versus the reporting JS isolate; Native-exclusive memory requires its own measurement. |
| Reads and delivery       | Fresh-process backend open, time to first/latest readable window, adjacent cursor page, absolute jump to oldest, targeted old-turn lookup, full export and incremental delivery/catch-up. State which operations load intermediate pages/bodies and whether Loro already holds its full document. Distinguish writer-only, observer and end-to-end visible latency.                                                                                                                                          |
| CPU and storage          | Process CPU and wall time per stage; distinguish chunk-only CPU from total-stage CPU. Empty/final control and history DB bytes, payload bytes, sampled WAL/SHM bytes and growth versus message/body count. For sync tests also show HTTP body bytes, Stream offset advance, network conditions and recovery traffic. Local SQLite tests mark network/sync rows `not measured`.                                                                                                                               |
| Correctness and coverage | Complete expected output, retry stability, fresh-reader/reopen digests, branch/receipt/proof failures, complete unique paging, SQLite checks, source hashes and restoration. List skips, timeouts, OOM/limits, missing categories and unmatched consumer behavior explicitly.                                                                                                                                                                                                                                |

The summary states which goal improved, which remained unchanged or regressed,
and which is unproven. Every long-conversation conclusion includes both the
memory-growth and latency tables and its measured scale. Never substitute a warm
tail-write result for cold-open, memory or history-scaling evidence.

Memory samples must identify actions performed before sampling. Walking to the
oldest range can populate a page cache with the entire tested history; that is
different from retaining only the latest window. JS garbage collection and heap
reservation make RSS growth insufficient to diagnose a leak. Forced-GC retention
experiments, if needed, are separate from ordinary latency runs and are labeled.
Do not add JS heap, external and RSS into a purported total, or treat DB/WAL bytes
as process memory. A zero sample count means unavailable, not zero cost.

Keep expensive scale experiments manual. Extend the existing harness for missing
measurements when needed, preserving the same synthetic business content and
durability; do not turn timing expectations into CI assertions or repeat unrelated
completed suites. If scale/coverage is incomplete, report that gap rather than
declaring the performance objective complete.

## Accept results and diagnose failures

- Require expected full text/tool output, receipt retry stability, exact reopen
  digest, complete unique paging IDs, and equal canonical business-content
  digests across backends. Performance numbers with a failed digest are invalid.
- After processes close, run SQLite `quick_check` on every generated database.
  Never open the Rust-owned database using another SQLite library in its process.
  Raw Native probes must use the SDK canonical JSON encoder and explicit queue
  bounds; they localize a cost but omit application receipts/indexes/consumers.
- Follow the [report contract](#report-contract), including memory trajectories,
  operation categories, long-history coverage and missing measurements.
  SQLite page bytes, WAL/SHM allocation, serialized content, HTTP bodies and Stream
  offset movement are different metrics; never label one as another.
- An absent export or unexpected loaded path is setup failure: correct the source
  pair before rerunning affected cases. Separate excluded setup runs from results.
  A child cancelled by a parent timeout is not an assertion result. Preserve the
  failure and rerun that owning suite in isolation once; report both outcomes.
  Likewise, a loopback transport failure in unchanged Rust requires diagnosis,
  not a new algorithm or a blanket claim that all Rust tests passed.
- Preserve raw samples, source hashes, workload parameters, exit statuses and
  complete errors outside Git; publish only synthetic summaries. Restore every
  changed dependency link/source file in a `finally` block and verify restoration
  if an archived workspace was used. Prefer isolated clones so swapping source
  files is unnecessary. A successful benchmark never authorizes deployment.

Update this guide and its owning benchmark when a repeatable setup issue is found.
Keep per-change conclusions in the owning Agent Note rather than creating a new
test recipe for every PR.
