# Stage 13.7 — Deterministic Replay and Reconciliation Checker

## 13.7.0 Purpose

Add a verification pipeline that replays chain history deterministically and proves off-chain reconstructed state matches on-chain truth.

This stage is verification only.

- It does not mutate contracts
- It does not mutate indexer source of truth
- On-chain state is final authority

---

## 13.7.1 Scope

In scope:

- deterministic replay script
- reconciliation report generation
- mismatch diff output
- repeatability checksum
- warn-only CI behavior

Out of scope:

- auto-healing indexer state
- replacing existing indexer runtime
- on-chain assertions

---

## 13.7.2 Inputs and Event Set

Replay input source:

- chain logs from deployment block to latest block

Required events:

- OrderBook:
  - `OrderPlaced`
  - `OrderFilled`
  - `OrderCancelled`
- Snapshot dividends:
  - `DividendDeclared`
  - `DividendClaimed`
- Merkle dividends:
  - `MerkleDividendDeclared`
  - `MerkleDividendClaimed`
- Award:
  - `AwardClaimed`
- Leveraged:
  - mint and unwind events emitted by leveraged router/token

---

## 13.7.3 Reconstructed State Model

Replay must build deterministic maps:

- `orderStats`
  - placed count
  - cancelled count
  - filled qty totals by symbol
- `walletStats`
  - traded qty by wallet and symbol
  - fill counts as maker and taker
- `dividendSnapshotStats`
  - claimed total by `(token, epochId)`
  - claimed flags by `(token, epochId, wallet)`
- `dividendMerkleStats`
  - claimed total by `epochId`
  - claimed leaf indices by `epochId`
- `awardStats`
  - claimed flags by `(epochId, wallet)`
- `leveragedStats`
  - minted and unwound qty/value totals by wallet/product

Determinism rules:

- sort logs by `(blockNumber, transactionIndex, logIndex)`
- fixed decimal conversion rules
- no wall-clock timestamps in checksum model

---

## 13.7.4 On-chain Reconciliation Checks

For each module compare replay vs on-chain views.

OrderBook:

- replay fill totals vs filled quantities implied from on-chain order state and logs
- replay open/closed expectations vs on-chain order fields (`active`, `remaining`)

Snapshot dividends:

- replay `claimed total` vs `epochs(token, epoch).totalClaimedWei`
- replay claimed flags vs `isClaimed(token, epoch, wallet)`

Merkle dividends:

- replay `claimed total` vs merkle epoch `totalClaimedWei`
- replay leaf claims vs `isClaimed(epoch, leafIndex)`

Award:

- replay award claim flags vs `hasClaimed(epoch, wallet)`

Leveraged:

- replay unwind/mint aggregates vs position and event-derived consistency checks

Output mismatch format:

- module
- key path
- expected (replay)
- actual (on-chain)
- severity

---

## 13.7.5 Scripts and Commands

New script:

- `scripts/verify/replay-reconcile.js`

Config:

- `scripts/verify/reconcile-config.json`
  - contract addresses
  - deployment block
  - sample wallet list
  - module toggles

Command:

- `npm run verify:reconcile`

Output:

- `reports/reconcile/latest.json`
- optional archived run:
  - `reports/reconcile/history/<timestamp>.json`

Report fields:

- run metadata
- chain and block range
- counts by event type
- reconciliation summary
- mismatch list
- deterministic checksum
- status: `ok` or `mismatch`

---

## 13.7.6 CI and Exit Behavior

Decision locked:

- warn-only CI mode

Behavior:

- command exits zero even with mismatches
- mismatches still printed and saved in report
- if status mismatch, add clear warning banner in console output

---

## 13.7.7 Tests

New test file:

- `test/reconcile.replay.test.js`

Required test scenarios:

1. deterministic replay on fixed fixture gives zero mismatches
2. running same replay twice gives identical checksum
3. tampered expected state triggers mismatch detection
4. mismatch report contains exact path-level diff entries

---

## 13.7.8 Acceptance Criteria

1. `npm run verify:reconcile` produces deterministic report
2. unchanged chain yields same checksum across repeated runs
3. mismatch mode is correctly detected and surfaced
4. checker uses on-chain truth for all final comparisons
5. CI remains warn-only, not hard fail
