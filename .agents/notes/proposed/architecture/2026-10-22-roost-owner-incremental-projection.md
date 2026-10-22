# Incremental projection for the Lody Roost owner

Status: proposed
Translation: current

[中文](2026-10-22-roost-owner-incremental-projection.zh.md)

## Abstract

Long-conversation measurements show that Lody's Roost integration still performs
whole-message work around small native edits. A local CPU diagnostic identifies
repeated JSON encoding/decoding, including conversions of unchanged window rows
and body conversion merely to build an identity index. The first implementation
removes redundant conversions while retaining authoritative reads, and its four
real-Native regression suites pass 107 cases with both v8 and v9 candidates.
Installing committed deltas and incrementally advancing the tail window remain
proposals; this first step does not establish the long-conversation performance goal.

## Evidence and scope

The same-host Linux long-workload comparison is recorded in
[Roost #22](https://github.com/loro-dev/roost/pull/22). Its v8/v9 comparison uses
identical Lody runtime source and does not attribute the effect of every earlier
Lody optimization. Content cloning, post-commit full-message refresh, and window
reloads already exist in Lody commit cf1ee8dcbd / PR #1329. The patch-write path
added in a4de9a264 / PR #1626 retains that refresh. This establishes provenance of
these specific operations, not absence of every possible historical regression.

A fresh local Mac diagnostic uses the real Lody backend and v9 Native addon,
1000 individual 1 KiB low-repetition appends, a 16 KiB tool result, SQLite WAL/FULL,
and persistence after every action. Main-thread V8 sampling covers the write
stage; interleaved readChanges is disabled to separate consumer reads. Content and
receipt retry assertions are retained. It is a diagnostic, not a before/after
optimization benchmark or a Rust-worker profile.

In that diagnostic, 10.44 seconds of 21.17 seconds of sampled wall time are self
samples in Roost's JSON codec: 49.3% of all samples, 65.9% excluding idle/program.
Inclusive stack groups overlap and must not be summed. The original Native-only
microbenchmark omits Lody's receipts/control/projection work and cannot establish
complete-flow performance. Synthetic profiles and the temporary harness are kept
outside the repository under the existing packed-storage research artifacts.

A second diagnostic has 50 rounds / 100 messages, 200 appends and one 16 KiB
tool result per assistant. Codec self samples are 2.51 seconds of 11.71 seconds,
42.4% excluding idle/program. Both runs verify complete business content and
receipt retries, then verify the same full digest after reopening in a new
process. These identify avoidable work; they do not quantify its removable share
or compare a new implementation with Loro. Whole-message cloning is present but
must not be called the largest CPU cost based on these profiles.

Correction to the earlier validation attribution: exporting
NAPI_RS_NATIVE_LIBRARY_PATH for an entire workspace overrides other napi-rs
bindings too. Rolldown then reports Class extends undefined and Oxlint reports
lint is not a function because they loaded the Roost binary. The earlier
site-docs failure is not evidence of an independent repository defect. Full
workspace verification instead stages the binding only beside the isolated
candidate Native package and runs without the global override. No shared pnpm
store or checked-in dependency version is modified. Individual Native-only
test commands may use an explicit override with the matching candidate binary.

## Changes to assess

1. In rebuildSegmentIndexes, derive the key from businessId/segmentId directly.
   adaptRoostProjectedMessage currently converts and validates the body even
   though the resulting body is discarded. In refreshTurnProjections, retain
   unchanged row projections and convert only changed rows. Preserve the current
   native read, receipts, validation boundaries and publication ordering.
2. For an unsealed local edit, stage a private projection delta and install it
   only when Native's returned event interval and ownership evidence certify the
   exact successful transaction. Existing expectedEventCursor/expectedIndexes,
   commit metadata and generation fencing provide relevant primitives. A lost
   reply, foreign mutation, pending remote work, or uncertain generation must use
   authoritative reconstruction; receipt presence alone is not sufficient.
3. For a linear tail append, update the bounded window instead of rehydrating
   unchanged bodies. Branch state, logical count and pagination cursors remain
   SDK-owned; extend the Roost TypeScript helper if the existing mutation result
   cannot safely advance them. Do not duplicate its private branch format in Lody.
4. Remove whole-turn cloning/diffing from common streaming updates by producing
   deltas from the semantic reducer with structural sharing. Preserve fragmented
   thinking/plan markup, text normalization, tool updates and Unicode scalar
   offsets. Simply sending every raw notification as appendText changes behavior.

The first step is Lody-only. Later steps may need a Roost TypeScript API change;
current evidence does not require a Rust storage or wire-format rewrite. This
proposal adds no legacy-format reader, migration, receipt pruning, deferred
durability, or weaker signature/seal checks. Public lossless JSON validation
must not be disabled to improve a benchmark.

## Ownership and verification before implementation acceptance

The first implementation PR starts from packed-storage-contract and changes only
Lody's redundant projection work: build identity indexes without body conversion,
retain unchanged decoded rows, and reuse the already validated decoded primary
when calculating a patch against the exact installed physical row. Keep Native
authoritative refresh and all transaction/publication/recovery checks. Validate
caller isolation and interleaved same-session mutations with the real backend,
then compare the same durable synthetic workloads with the unchanged base.
Post-commit delta installation and SDK-owned incremental append remain a separate
scope until this step is measured; this first step does not claim constant-cost
streaming or completion of the long-conversation performance goal.

Trigger: a serialized owner mutation or an external observation. The current
owner retains raw Native requests until settlement. Caller cancellation does not
make an uncertain commit safe to repeat. Install only committed state, advance
the revision/checkpoint after its matching projection, and invalidate/rebuild
when ownership or coverage is uncertain. Recovery must preserve availability
and complete existing close/flush behavior. No lifecycle migration is proposed:
the remaining Session/Promise consumers prevent a small complete native Effect
unit, and migration is unrelated to removing repeated projection work.

Extend the real-backend suites for Unicode and split markup, mixed tools,
no-op/duplicate/conflicting notifications, lost replies, concurrent native writes,
pending remote work, seals/state corrections, branch changes, cursor boundaries,
reopen, and caller isolation from internal caches. Verify against the unchanged
semantic reducer, not a duplicated approximation of its output. The existing
[atomic metadata decision](../../implemented/architecture/2026-10-21-roost-atomic-commit-metadata.md)
continues to own persistence and release gates.

Performance acceptance requires paired before/after runs plus the same-content
durable Loro reference. Separately vary total history, current reply length and
window size; measure open-to-tail, append, new-message, paging, CPU and RSS. Keep
long runs outside ordinary CI. No orders-of-magnitude claim follows from this
profile. Only Lody's repeated projection conversion changes; Native storage,
dependency versions, deployment and stored databases are unchanged.

## First-step runtime results

The final implementation reuses rows by the exact physical message object and
captures the corresponding decoded window before asynchronous refresh. The
decoded-content shortcut also compares the complete business/segment identity.
Native still supplies the changed authoritative body after each commit; no
transaction, signature, receipt, publication or durability check is removed.
The added real-backend regression mutates an exposed copy, retries a Unicode
notification, interleaves a sealed-row correction through a peer, appends again,
and compares complete history after a new owner opens it.

Linux measurements use one unchanged v9 addon for both Lody variants, WAL/FULL
and a barrier per action. The many-message workload has 100 rounds / 200 messages
/ 2000 appends and 2,220,771 visible JSON bytes. The single-reply workload has
1000 x 1 KiB appends and 1,041,086 visible JSON bytes. Each assistant retains a
16 KiB tool result. Figures are medians of two before/two final-source after
runs; the Loro reference has one run. Completed original baselines are reused
after tightening snapshot matching, so final order is not fully alternating.
The superseded candidate revision is retained separately and excluded.

| Metric | Before | Reused projections | Same-content Loro |
| --- | ---: | ---: | ---: |
| Many-message append p95 | 37.31 ms | 30.01 ms | 3.86 ms |
| Many-message total append time | 61.10 s | 48.97 s | 5.07 s |
| Many-message append CPU | 43.70 s | 29.86 s | 2.39 s |
| Many-message new-message p95 | 341.61 ms | 332.65 ms | 4.56 ms |
| Single-reply append p95 | 131.45 ms | 110.30 ms | 12.30 ms |
| Single-reply total append time | 75.67 s | 64.69 s | 7.80 s |
| Single-reply append CPU | 68.43 s | 57.16 s | 6.73 s |

Append p95 improves by about 19.6% / 16.1%, and append CPU by about 31.7% / 16.5%.
This is useful but does not reach the original performance goal. New-message
cost remains dominated by the unchanged reload path; the full growing reply is
still read and processed. There is no demonstrated storage reduction: those
paths and formats are unchanged, and small database-size differences include
random identities/compression. Sampled whole-worker RSS is not Roost-exclusive
memory and is not used as an independent memory-improvement claim.

All ten write/reopen/paging cases pass, canonical message-content digests match
across backends, each reopened full-history digest matches its write result, and
202 replay checks per Roost variant preserve content. Eighteen benchmark SQLite
databases pass quick_check; both Roost variants use container 9. The research
source is restored and the temporary benchmark is removed from ordinary suites.
Raw samples, final source hashes and the restoration record remain under the
owner-projection-optimization research artifact directory.

The first read samples have variable paging tails. Three additional alternating
read pairs pass all 12 process checks, but their per-run page-p95 median is
86.07 -> 94.35 ms and does not justify a no-regression claim. Eight crossover
reads then run each source against each same database: on the baseline database,
median total paging is 764.63 -> 763.29 ms; on the candidate database it is
802.79 -> 860.02 ms. Individual paired differences reverse direction and ranges
overlap substantially. This does not identify a consistent source-code slowdown,
and the small noisy sample does not prove every read path is regression-free.
The source and temporary test are restored/removed after both investigations.

Final validation: both candidate layouts pass the four owning suites (107 cases),
CLI typecheck and scoped type-aware lint pass (72 existing warnings), root format
passes, and docs check has 0 errors / 71 existing warnings. Full pnpm check passes
without the generic Native override, using the correctly assembled isolated
candidate package and split host binding. Its six packaging tests pass as well.
Initial setup attempts using an incompatible addon, a workspace-wide override,
or an incomplete private package are not passing verification. The parent still
requires a coordinated published Native release; candidate-linked local checks
do not establish registry CI success.
