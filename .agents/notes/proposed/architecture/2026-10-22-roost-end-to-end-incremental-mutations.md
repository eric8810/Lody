# End-to-end incremental Roost mutations

Status: proposed
Translation: current

[中文](2026-10-22-roost-end-to-end-incremental-mutations.zh.md)

## Abstract

Native text append is incremental, but Lody still copied complete message/state
bodies and reread loaded history around commits. This change carries shared
semantic mutation plans through validation, Native content operations and private
projection installation, and uses SDK-certified directory transitions. It covers
markup, tools, finish actions and resumed state as well as ordinary text appends.
Public ownership, durable acknowledgment and authoritative recovery remain intact;
performance conclusions are bounded by the paired workloads below.

## Problem and decision

This continues the [atomic checkpoint work](2026-10-22-roost-atomic-content-checkpoints.md)
and [earlier projection cuts](2026-10-22-roost-owner-incremental-projection.md).
A synthetic boundary probe measured Native append p50 of 0.178/0.167/0.172 ms
at 0/256 KiB/1 MiB old text, while the application path grew from 1.621 to
4.770 ms. Native-only omits receipts, indexes, control persistence and consumers;
it localizes redundant application work rather than promising achievable latency.

The initial implementation optimized suffix-only primary edits and local directory
creation. It did not complete complex operations or resumed-state staging. The
completed consumer now follows the same semantic and durability rules across them:

- The shared reducer and action planner use private copy-on-write drafts and record
  authored paths. They own incoming data and retain untouched stored values. Writer
  validation remains authoritative: paths select affected **validated top-level
  subtrees**, never raw Immer patch values. Validation may normalize siblings in
  that field, so selecting only the narrow leaf would be incorrect.
- Exact text-suffix hints avoid rescanning ordinary appends. Complete text rewrites
  still need compact scalar-indexed splice encoding. Incomplete thinking/plan
  blocks skip the full parser until a complete closing delimiter exists; bounded
  suffix analysis detects split delimiters. The existing parser, overlap/snapshot
  deduplication, per-event order and malformed-scalar repair/refusal remain shared.
- Private staging handles `set`, `remove`, `appendText`, `spliceText` and
  `spliceArray` in both application and lossless SDK representations. Only edited
  ancestors/new values are copied. Added keys use Native's canonical key order;
  own-key guards and Unicode scalar offsets match the actual Native boundary.
- A staged result installs only after Native metadata, exact event coverage, owner
  generation and unchanged window checks. State overlays additionally require the
  derived-index group to have applied. An edit plus seal reads the authoritative
  small header/hash. Uncertain, foreign or unsupported transitions use existing
  authoritative body reads; final checkpoint publication still verifies coverage.
- Resumed state composes an append only with the last related append operation;
  otherwise it rebuilds affected fields' baseline-relative deltas. This preserves
  operation ordering without an unbounded program. Projection copies paths instead
  of deep-copying the immutable primary, and exact private SDK snapshots retain
  decoded values. Public reads and model-summary output remain detached. Borrowed
  command reads stay inside the serialized writer; external acceptance queries use
  the formal reader.

Roost owns checkpoint and branch evidence. Every retained checkpoint proof row is
still compared atomically on each write; stale refresh occurs once only when
Native proves no write happened. A directory transition certifies a confirmed
local linear append's membership, not old-body freshness. Forks, remote
interleavings, incomplete pages and uncertain outcomes retain recovery.

No Rust/Native runtime, storage/wire format, signing, retention or durability
change is needed. No compatibility reader, migration, release or deployment is
added. This unit is pure planning/projection work, not an Effect lifecycle change.
Unresolved observable-behavior or guarantee changes must stop for discussion.

## Validation and measured limits

The [validation workflow](../../../docs/roost-validation.md) owns setup, owning
suites, fixed manual workloads and failure handling. The durable harness/config
live under `apps/cli/benchmarks`, outside default CI. It now also covers mixed
markup/tool/plan changes and finish/reopen followed by resumed streaming.

Linux x64, Node 24.22, 2 vCPU; baseline Lody `9f497346a` and candidate use
Roost `d4b07d4` with the same Native binary. Both sides use SQLite WAL/FULL,
per-action control persistence and separately timed live incremental reads.
Baseline/candidate run A–B–B–A; Loro uses candidate shared semantics in one
reference trial. Values are medians of trial p95s in milliseconds.

| Fixed workload / metric                                | Before completion | Completed |  Loro |
| ------------------------------------------------------ | ----------------: | --------: | ----: |
| 100 rounds, 2,000 × 256 B chunks: chunk p95            |             11.81 |     11.83 |  4.00 |
| Same: finish p95                                       |             25.49 |     20.44 |  3.98 |
| One reply, 1,000 × 1 KiB chunks: chunk p95             |             11.58 |     11.81 | 14.19 |
| 10 replies, 100 × 1 KiB each, mixed/resumed: chunk p95 |             33.09 |     15.15 |  4.94 |
| Same: final finish p95                                 |             81.76 |     32.38 |  4.94 |

Each assistant retains a 16 KiB synthetic tool result. Mixed chunks additionally
include thinking delimiters, Unicode and tool/plan updates, with finish/open
halfway through each reply. Mixed chunk write CPU falls from 15.32 to 7.47 seconds;
sampled pre-validation whole-process peak RSS falls from 559 to 515 MiB. RSS
includes the runner/control plane, not Roost-exclusive memory. Ordinary append
latency is effectively unchanged. The mixed finish/open pair itself is 98.65 →
104.36 ms (Loro 23.44 ms); no improvement is claimed for that pair.

Combined database size remains about 14.39/6.56/8.80 MB for many/single/mixed,
versus Loro 2.90/1.54/2.04 MB. This changes latency/CPU, not retained-log size.
Cold older-page/full-read costs and constant SDK/Worker overhead remain; there is
no broad ultra-long or network performance win claimed over Loro.

All 45 write/reopen/paging stages, complete expected output, receipt retries,
canonical cross-backend business digests, exact reopened full digests and 27
post-close SQLite checks pass. Measured runtime/harness source hashes match the
candidate; research sources and dependency links are restored. A setup-only
attempt put logs into the required empty data directory and was rejected before
measurement; its failure/restoration are retained and excluded from results.

The earlier text-only comparison used Lody `f06b820f3` / Roost `ff1a639` as its
baseline: growing-reply chunk p95 fell from 26.30 to 11.98 ms, and many-message
creation p95 from 103.01 to 68.34 ms. Those results belong to the earlier source
pair; they are not relabeled as measurements of the completed extension.

Current owning checks: CLI 128 cases and shared semantic/action suites 89 cases
pass. They compare planned output with the established reducer, every tested
Unicode/tag/internal-marker split, malformed scalars, caller-input ownership,
Native operation results, canonical fresh-reader/reopen output, receipts, paging,
branch/owner fences and resumed state. The mixed Native case makes body readback
unavailable during writes and finish, then verifies the actual stored/reopened
result. Added-key checks include an own `__proto__` field and rejection of invalid
scalar offsets without mutation.

Lody root `corepack pnpm check`, `corepack pnpm format` and documentation checks
pass with the matching local SDK. Full checks retain their reported opt-in skips;
the owning 217 cases above run without skips. The first root attempt stopped at
a type-aware lint error in the pre-existing malformed-scalar branch; its explicit
type assertion preserves runtime coercion/refusal, and the complete rerun passes.

Unchanged SDK/Native validation is reused: Native 59 cases, SDK Chromium/Node 101
and WebKit 63 pass. The initial parallel SDK attempt hit parent timeouts; cancelled
children are not passes. Rust fmt/clippy pass; the root serial Rust attempt stopped
at unchanged `rs3_link` loopback `Transport(Unavailable)`, whose isolated rerun
passes. No complete green Rust-suite result is claimed for that attempt. This
extension changes no SDK/Rust runtime or addon build input, so it reuses their
recorded binaries and hashes rather than rebuilding them.

Review: [Lody #1817](https://github.com/LodyAI/Lody/pull/1817),
[Roost #26](https://github.com/loro-dev/roost/pull/26). They remain draft stacks on
Lody #1811 / Roost #25. A coordinated Roost release and real dependency pin remain
necessary: published 0.2.0 lacks the new directory API; source-linked checks do not
remove that release blocker. Synthetic raw samples and hashes stay outside Git in
the validation workspace's `complete-incremental-20261022` directory.
