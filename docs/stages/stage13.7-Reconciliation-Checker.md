# Stage 13.7 — Deterministic Replay and Reconciliation Checker

## 13.7.0 Purpose

Add an in-system reconciliation service that replays chain history deterministically and proves off-chain reconstructed state matches on-chain truth.

This stage is verification only.

- It does not mutate contracts
- It does not mutate indexer source of truth
- On-chain state is final authority

---

## 13.7.1 Scope

In scope:

- deterministic replay engine inside backend service
- admin/API-triggered reconciliation run
- optional scheduled background reconciliation run
- latest status endpoint for UI
- mismatch diff output
- warn-only mismatch behavior

Out of scope:

- auto-healing indexer state
- replacing existing indexer runtime
- on-chain assertions
- separate local-only verification toolchain for this stage
- file-report pipeline as primary operator flow

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

## 13.7.5 System Endpoints and Service Behavior

System endpoints:

- `POST /api/reconcile/run`
  - triggers one reconciliation run immediately
- `GET /api/reconcile/status`
  - returns latest run summary and mismatch count
- `GET /api/reconcile/report`
  - returns latest detailed report payload

Service behavior:

- backend computes reconciliation from deployment block to latest block
- backend stores latest result in in-memory runtime state
- optional interval run via server timer for ongoing monitoring
- no local CLI script is required for stage acceptance

Output:

- latest summary + mismatches exposed via API and admin page
- optional export/history endpoint can be added later, not required in this stage

Report fields:

- run metadata
- chain and block range
- counts by event type
- reconciliation summary
- mismatch list
- deterministic checksum
- status: `ok` or `mismatch`

---

## 13.7.6 UI and Admin Integration

- Admin page section:
  - Run reconciliation button
  - Last run time
  - Status badge (`OK` / `MISMATCH`)
  - mismatch count
  - view latest report details

No end-user pages are changed in this stage.

---

## 13.7.7 Exit Behavior

Behavior:

- reconciliation run completes even if mismatches are present
- status is set to `mismatch` and details are returned
- service remains online and warns only

---

## 13.7.8 Tests

New test file:

- `test/reconcile.system.test.js`

Required test scenarios:

1. endpoint run returns valid report schema
2. unchanged state yields stable checksum
3. injected mismatch path is detected and reported
4. status endpoint returns latest summary after run

---

## 13.7.9 Acceptance Criteria

1. `POST /api/reconcile/run` produces deterministic report payload
2. unchanged chain yields same checksum across repeated runs
3. mismatch mode is correctly detected and surfaced in admin endpoint/UI
4. checker uses on-chain truth for all final comparisons
5. run behavior is warn-only, not hard fail
