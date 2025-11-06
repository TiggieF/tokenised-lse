# Stage Development Plan

Each stage delivers a deployable increment of the system.
Advancement to the next stage requires **approval** and **passing all defined tests**.

---

### Stage 1 — TGBP Token

**Objective:**
Implement the base ERC-20 TGBP stable token with capped supply, role-based minting, and one-time airdrop per wallet.

**Key Files:**

* `contracts/TGBP.sol`
* `scripts/deploy_stage1.js`
* `test/stage1_TGBP.test.js`

**Approval Criteria:**

* Airdrop works only once per wallet
* Cap enforced on total supply
* Role permissions correctly implemented
* All tests pass on local Hardhat

---

### Stage 2 — Listings & Factory

**Objective:**
Enable admin to list new stock tokens via a factory that deploys EquityToken contracts and registers them in a central registry.

**Key Files:**

* `contracts/EquityToken.sol`
* `contracts/EquityTokenFactory.sol`
* `contracts/ListingsRegistry.sol`

**Approval Criteria:**

* Factory deploys unique EquityToken per symbol
* Registry correctly tracks listings and prevents duplicates
* Role-based permissions validated in tests

---

### Stage 3 — PriceFeed Oracle

**Objective:**
Build an on-chain oracle to store and update stock prices in pence, controlled by an ORACLE_ROLE (admin backend).

**Key Files:**

* `contracts/PriceFeed.sol`
* `backend/routes/admin.js`

**Approval Criteria:**

* Only ORACLE_ROLE can update prices
* Prices stored with timestamps
* “Fresh/Stale” logic (≤60s) functions correctly in UI

---

### Stage 4 — OrderBookDEX

**Objective:**
Develop the on-chain decentralised exchange supporting limit orders, partial fills, and cancellations, using TGBP as the settlement token.

**Key Files:**

* `contracts/OrderBookDEX.sol`
* `test/stage4_OrderBookDEX.test.js`

**Approval Criteria:**

* Partial fills function correctly
* Order matching maintains price-time priority
* Fee (1 ppm) charged to taker only
* Balances conserved before and after trades

---

### Stage 5 — Dividends

**Objective:**
Allow admin to declare dividends for listed stocks, distributing TGBP proportionally to token holders.

**Key Files:**

* `contracts/Dividends.sol`
* `test/stage5_Dividends.test.js`

**Approval Criteria:**

* Snapshot-based distribution accurate
* Users can claim dividends once
* Unclaimed funds returned after expiry
* No reentrancy vulnerabilities

---

### Stage 6 — FeePool Rewards

**Objective:**
Track per-epoch trading volumes and reward the top trader with 3 TGBP every 3 minutes.

**Key Files:**

* `contracts/FeePool.sol`
* `test/stage6_FeePool.test.js`

**Approval Criteria:**

* Correct top trader identified
* Rewards distributed once per epoch
* Tie-break logic deterministic
* DEX integration for trade volume confirmed

---

### Stage 7 — Portfolio Aggregator

**Objective:**
Aggregate user holdings and compute total portfolio value using live on-chain prices.

**Key Files:**

* `contracts/PortfolioAggregator.sol`
* `test/stage7_Aggregator.test.js`

**Approval Criteria:**

* Accurate portfolio valuation
* Data consistency with `PriceFeed` and `ListingsRegistry`
* Successful read-only query tests

---

### Stage 8 — Frontend Integration

**Objective:**
Deliver Yahoo Finance-style UI with wallet connection, admin control, live charts, and holders/profile tabs.

**Key Files:**

* `frontend/` (HTML, JS, CSS)
* `backend/routes/admin.js`, `backend/routes/market.js`

**Approval Criteria:**

* Admin can list top 10 LSE companies
* Airdrop and trading flows functional
* Live charts and holder breakdown displayed
* UI passes manual testing on local Hardhat network
