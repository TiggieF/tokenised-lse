# Stage 13.8 — Gas and Cost Evaluation Pack

## 13.8.0 Purpose

Create repeatable gas and cost measurements for core and stress scenarios, then expose results in a dedicated UI page.

Key decision for this stage:

- no local-storage persistence dependency for gas reports

Gas data should be generated on demand and served via API.

---

## 13.8.1 Scope

In scope:

- on-demand gas benchmark runner
- core scenario set
- stress scenario set
- regression delta computation
- dedicated gas page in UI

Out of scope:

- long-term database for historical gas analytics
- third-party telemetry integration

---

## 13.8.2 Measurement Architecture

Runner entrypoint:

- `scripts/gas/run-gas-pack.js`

Scenario modules:

- `scripts/gas/scenarios/core.js`
- `scripts/gas/scenarios/stress.js`

Server integration:

- backend spawns runner or imports modules and returns JSON response
- response kept in memory cache with short TTL for page refresh speed
- no required write to `cache/` or local report files

---

## 13.8.3 Scenarios

## 13.8.3.1 Core scenarios

1. list symbol
2. place buy limit order
3. place sell limit order
4. cancel order
5. snapshot dividend declare
6. snapshot dividend claim
7. merkle dividend claim
8. leveraged mint
9. leveraged unwind
10. award claim

## 13.8.3.2 Stress scenarios

1. deep orderbook match loop (`N` levels)
2. large merkle claim sequence (many users claiming sequentially)
3. repeated award trade reporting under high fill density

Stress parameters:

- fixed deterministic seeds
- documented `N` and account counts
- repeatable deployment fixture before each run

---

## 13.8.4 API and UI

New backend endpoints:

- `POST /api/gas/run`
  - runs selected suite (`core`, `stress`, or `all`)
  - returns full report JSON
- `GET /api/gas/latest`
  - returns last in-memory run result and timestamp
- `GET /api/gas/baseline`
  - returns baseline JSON currently tracked in repo config

New page:

- `scripts/ui/html/public/gas.html`

Page requirements:

- table of transaction types and gas used
- effective gas price
- cost in wei and eth
- delta vs baseline %
- status badge:
  - `OK`
  - `WARN` when increase is greater than threshold
- auto refresh every 10 seconds
- manual refresh button

Access behavior:

- page is public read-only
- admin-only controls for:
  - run benchmark suite
  - accept baseline
  - config writes

Navigation:

- link from main nav to gas page

---

## 13.8.5 Baseline and Threshold Policy

Baseline source:

- tracked static file in repo, for example:
  - `scripts/gas/baseline.json`

Regression threshold:

- warn-only if increase is greater than `15%`

Behavior:

- warnings shown in API response and gas page
- warnings do not fail CI in this stage

---

## 13.8.6 Report Schema

Each scenario row:

- `txName`
- `gasUsed`
- `effectiveGasPrice`
- `costWei`
- `costEth`
- `baselineGasUsed`
- `deltaPct`
- `status`

Report metadata:

- chain id
- rpc url label
- block range used
- commit hash
- run seed
- startedAt and finishedAt

---

## 13.8.7 Tests

New tests:

- `test/gas-pack.smoke.test.js`
  - runner executes and returns non-empty results
  - required fields exist in each row
  - threshold warning logic works

- `test/gas-report.schema.test.js`
  - validates report JSON schema

---

## 13.8.8 Commands

Package scripts:

- `npm run gas:pack`
- `npm run gas:pack:core`
- `npm run gas:pack:stress`

Optional verification chain command:

- `npm run verify:reconcile`

---

## 13.8.9 Acceptance Criteria

1. Core and stress suites run repeatably on local Hardhat
2. Gas page displays per-transaction gas and cost clearly
3. API returns baseline delta and warn-only status
4. No required local-storage report persistence
5. Smoke and schema tests pass
