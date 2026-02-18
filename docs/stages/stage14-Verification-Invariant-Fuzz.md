# Stage 14 — Final Verification Stage (Invariant and Fuzz Testing)

## 14.0 Purpose

This is the final rigor stage. It proves core correctness under large state-space exploration and random action sequences.

This stage should be executed after feature completion (Stages 10 to 13).
This stage is strictly local execution on Hardhat and does not include any Sepolia deployment work.

---

## 14.1 Tooling

Primary:

- Hardhat test runner
- property-style fuzz tests in JS/TS

Optional advanced:

- Echidna for Solidity invariants
- Foundry invariant mode (if introduced later)

---

## 14.2 Contract Coverage

- `OrderBookDEX`
- `Dividends`
- `Award`
- `PortfolioAggregator`
- `LeveragedTokenFactory`
- `LeveragedProductRouter`

---

## 14.3 Invariant Set

## 14.3.1 Conservation invariants

1. No spontaneous value creation in DEX:
- total debits equal total credits across maker/taker plus escrow transitions.

2. Order remaining quantity bounds:
- `0 <= remaining <= qty` always.

3. Cancel safety:
- cancelled order cannot be filled afterward.

4. Dividend one-claim rule:
- wallet cannot claim same `(equity, epoch)` twice.

5. Award uniqueness:
- epoch reward distributed at most once.

6. Leveraged burn settlement:
- unwind burn quantity equals user input quantity.
- user leveraged balance decreases exactly by burn amount.

## 14.3.2 State consistency invariants

1. Registry uniqueness:
- no duplicate listing symbol maps to multiple addresses.

2. Aggregator consistency:
- `cash + stock + leveraged == total` within exact integer arithmetic.

3. Portfolio rebuild consistency:
- indexer-rebuilt holdings match on-chain balances for sampled wallets.

---

## 14.4 Fuzz Matrix

Generate random sequences over:

- users: 5 to 20 accounts
- symbols: 3 to 20
- actions:
  - place buy
  - place sell
  - cancel
  - partial fill
  - full fill
  - dividend declare/claim
  - award finalize
  - leverage mint/unwind

Run lengths:

- smoke: 200 actions
- standard: 2,000 actions
- stress: 10,000 actions

Seeds:

- fixed seeds for reproducibility
- rotating seed in CI/local script

---

## 14.5 Required Test Files

- `test/invariants/orderbook.invariant.test.js`
- `test/invariants/dividends.invariant.test.js`
- `test/invariants/award.invariant.test.js`
- `test/invariants/portfolio.invariant.test.js`
- `test/invariants/leveraged.invariant.test.js`
- `test/fuzz/system.fuzz.test.js`

---

## 14.6 Failure Triage Protocol

On failure:

1. Save seed and action sequence.
2. Emit minimal reproducible replay script.
3. Classify bug:
- arithmetic/rounding
- role/permission
- state transition
- indexer mismatch
4. Patch contract or indexer logic.
5. Re-run same seed and full suite.

---

## 14.7 Reporting Artifact

Create `docs/verification-report.md` with:

- invariant catalog and rationale
- fuzz configuration
- coverage summary
- found bugs and fixes
- residual known limits

This report should be referenced in final project write-up.

---

## 14.8 Acceptance Criteria

1. All invariant suites pass under standard load.
2. Fuzz suite passes at stress load for at least 3 independent seeds.
3. Replay harness reproduces any prior failing seed deterministically.
4. Verification report is complete and linked in project README.
5. All verification runs are executed on local Hardhat network only.

---

## 14.9 Notes on Scope

Per current direction:

- keep security/admin-hardening out of this stage.
- focus on correctness and robustness of trading and accounting logic.
- defer Sepolia deployment/testing to Stage 15 only.
