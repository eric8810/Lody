# End-to-end incremental Roost mutations

Status: proposed
Translation: current

[中文](2026-10-22-roost-end-to-end-incremental-mutations.zh.md)

## Abstract

Native text append is incremental, but Lody copied and rescanned complete text
around each commit and reread a full branch window after local creation. This
change carries owned semantic append plans through validated persistence and
private projection installation, and uses SDK-certified directory transitions.
In the fixed durable Linux growing-reply case, chunk p95 falls from 26.30 to
11.98 ms; many-message creation p95 falls from 103.01 to 68.34 ms. Disk size is
unchanged in substance, and the many-message path remains slower than Loro.

## Problem and decision

Baseline: Lody `f06b820f3`, Roost `ff1a639`, after the
[atomic checkpoint work](2026-10-22-roost-atomic-content-checkpoints.md) and
[earlier projection cuts](2026-10-22-roost-owner-incremental-projection.md).
A separate synthetic boundary probe measured Native append p50 of
0.178/0.167/0.172 ms at 0/256 KiB/1 MiB old text, while Lody/Roost grew from
1.621 to 4.770 ms. Native-only omits application receipts, indexes, control
persistence and delivery; it localizes the extra work, not an attainable latency.

The shared reducer now returns an immutable mutation plan and explicit text
append intents. It preserves per-event processing, snapshot/overlap deduplication,
fragmented internal markers and thinking/plan tags. Private bounded suffix
analysis avoids rescanning ordinary clean text; complex text retains the existing
parser. Exact source checks invalidate analysis after caller mutation. Stored
malformed scalar repair/refusal semantics are preserved.

Lody borrows private serialized-write snapshots, validates every authored change,
stages only changed paths, then uses the existing logical projector without
another full detach. This retains canonical property order, overlays, defaults
and unknown stored fields. Public reads still detach. The small model summary is
also detached before crossing into the control document.

Roost owns checkpoint and branch evidence. Retained checkpoint preconditions are
still compared atomically on every write; stale invalidates and refreshes once
only when Native proves no write occurred. A directory transition certifies a
confirmed local linear append's membership, not freshness of old bodies. Native
metadata, actual event intervals, generation and final publication checks still
gate installation. Forks, remote interleavings, incomplete pages and uncertain
outcomes retain authoritative recovery. Rust/Native runtime code is unchanged.
A traced steady local creation now uses 97 rather than 237 Native calls; this is
a request-count diagnostic, not an internet latency measurement.

User authorization requires unchanged observable behavior/correctness; unresolved
guarantee changes stop for discussion. No old-format reader, migration, pruning,
durability reduction, release or deployment is included. Full-body reconstruction
at every chunk and authoritative rereads after every known local append were
rejected because existing transaction evidence suffices for private reuse.

## Verification and measured limits

The [validation workflow](../../../docs/roost-validation.md) owns reusable setup,
suite selection, fixed benchmark commands, metric definitions and failure handling.
The durable benchmark previously lived only in scratch artifacts; its synthetic
harness/config now live under `apps/cli/benchmarks`, outside default CI. Repeated
SDK/link setup must update that guide rather than create another temporary recipe.

Linux x64, Node 24.22, 2 vCPU; same Native binary, SQLite WAL/FULL and per-action
control persistence. Baseline/candidate ran A–B–B–A; Loro used candidate shared
semantics, one reference trial. Values are medians of trial p95s (milliseconds).
Live incremental reads are interleaved but timed separately from writes.

| Workload / metric                           | Baseline | Candidate |  Loro |
| ------------------------------------------- | -------: | --------: | ----: |
| 100 rounds, 2,000 × 256 B chunks: chunk p95 |    12.50 |     11.23 |  4.89 |
| Same: new-message p95                       |   103.01 |     68.34 |  5.17 |
| One reply, 1,000 × 1 KiB chunks: chunk p95  |    26.30 |     11.98 | 13.22 |

Both fixtures retain a 16 KiB synthetic tool result per assistant. Growing-reply
write CPU falls from 14.92 to 6.27 seconds; sampled pre-validation whole-process
peak RSS falls from 613 to 474 MiB. This includes the runner/control plane and is
not Roost-exclusive memory. Many-message combined database bytes remain about
14.38 MB versus Loro 2.90 MB; growing reply remains about 6.56 MB versus 1.54 MB.
This does not establish a large win over Loro for ultra-long conversations.
Remaining constant SDK/Worker overhead and retained-log amplification are open.

All 30 write/reopen/paging stages pass; complete expected text/tool output,
receipt retry, cross-backend canonical business digests, exact reopened full
digests and 18 post-close SQLite checks pass. Measured runtime source hashes match
the candidate and all research source/dependency links were restored.

Lody root `pnpm check` and format pass with the matching local SDK. Native 59
cases and SDK owning suites (Chromium/Node 101, WebKit 63) pass. The initial full
parallel SDK run hit parent timeouts; its cancelled children are not passes.
Rust fmt/clippy pass; the root serial test run stopped at unchanged `rs3_link`
loopback `Transport(Unavailable)`, whose isolated rerun passes. No complete green
Rust-suite result is claimed for that attempt. New manual entry discovery and lint
pass; it selects only the durable benchmark. Formatting/docs checks cover the guide.

Raw samples/hashes are local synthetic artifacts in the validation workspace's
`incremental-mutations-20261022/linux-results.json`; no user data enters Git.
This PR remains a draft stacked on Lody #1811 and the matching Roost SDK change
on Roost #25. A coordinated Roost release and real dependency pin are still needed;
the current published 0.2.0 SDK cannot satisfy the new directory API.
