# Stage Development Plan

Each stage delivers a deployable increment of the system.
Advancement to the next stage requires **approval** and **passing all defined tests**.

---

### Stage 1 — TToken Token

**Objective:**
Implement the base ERC-20 TToken stable token with capped supply, role-based minting, and one-time airdrop per wallet.

**Key Files:**

* `contracts/TToken.sol`
* `scripts/deploy-ttoken.js`
* `scripts/stage1/instructions.md`
* `test/ttoken.test.js`

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
Develop the on-chain decentralised exchange supporting limit orders, partial fills, and cancellations, using TToken (18dp) as the settlement token.

**Key Files:**

* `contracts/OrderBookDEX.sol`
* `test/orderbook-dex.test.js`

**Approval Criteria:**

* Partial fills function correctly
* Order matching maintains price-time priority
* No trading fee in Stage 4 (rewards handled in Stage 6)
* Balances conserved before and after trades

---

### Stage 5 — Dividends

**Objective:**
Allow admin to declare dividends for listed stocks, distributing TToken proportionally to token holders.

**Key Files:**

* `contracts/Dividends.sol`
* `test/dividends.test.js`

**Approval Criteria:**

* Snapshot-based distribution accurate
* Users can claim dividends once
* Unclaimed funds returned after expiry
* No reentrancy vulnerabilities

---

### Stage 6 — FeePool Rewards

**Objective:**
Track per-epoch trading volumes and reward the top trader with 1 TToken every 90 seconds.

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
* `test/portfolio-aggregator.test.js`

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

* Admin can list top 10 companies
* Airdrop and trading flows functional
* Live charts and holder breakdown displayed
* UI passes manual testing on local Hardhat network

---

### Stage 10 — Indexer + User Transactions + Order Cancellation

**Objective:**
Create an off-chain event indexer, expose wallet-scoped transaction history, and add cancel-order flows from a dedicated Transactions page.

**Key Files:**

* `scripts/indexer/*` (new)
* `scripts/ui/html/server.js`
* `scripts/ui/html/public/transactions.html` (new)
* `scripts/ui/html/public/index.html`

**Approval Criteria:**

* Full event backfill and live tailing work from deployment block
* Wallet sees only own events and orders
* Cancel action can be triggered from transaction history
* Portfolio cost basis input data is produced by indexer

---

### Stage 11 — Portfolio Economics + Dividends + Award + Aggregator Wiring

**Objective:**
Complete economics and analytics: cost basis, realized/unrealized PnL, current valuation, and wire Dividends/Award/PortfolioAggregator to API and frontend.

**Key Files:**

* `scripts/ui/html/server.js`
* `scripts/ui/html/public/portfolio.html`
* `scripts/ui/html/public/admin.html`
* `scripts/ui/html/public/dividends.html` (new)
* `scripts/ui/html/public/award.html` (new)

**Approval Criteria:**

* Portfolio shows cost basis, realized PnL, unrealized PnL, and total return
* Dividends declare/preview/claim flows work end-to-end
* Award current and historical epochs are visible
* Aggregator contract endpoints are exposed and consumed in UI

---

### Stage 12 — Leveraged Token Factory (TSLA5L and others)

**Objective:**
Ship leveraged products via factory pattern for listed equities, including mint/unwind lifecycle and portfolio + transaction visibility.

**Key Files:**

* `contracts/LeveragedToken.sol` (new)
* `contracts/LeveragedTokenFactory.sol` (new)
* `contracts/LeveragedProductRouter.sol` (new)
* `scripts/ui/html/server.js`
* `scripts/ui/html/public/trade.html`
* `scripts/ui/html/public/portfolio.html`

**Approval Criteria:**

* Admin can enable leveraged products for listed NASDAQ symbols
* Product leverage options are limited to long-only `3x` and `5x`
* User can mint leveraged product and unwind later
* Unwind burns leveraged tokens and settles in TToken
* Transactions and portfolio include leveraged lifecycle events

---

### Stage 13 — Tokenized NASDAQ Realism Features

**Objective:**
Add realistic exchange behaviors to increase technical depth and grading impact.

**Key Files:**

* `contracts/OrderBookDEX.sol`
* `scripts/indexer/*`
* `scripts/ui/html/public/admin.html`
* `scripts/ui/dataFetch/tsla-yahoo/chart.html`

**Approval Criteria:**

* Admin can add new NASDAQ symbols and they become tradable end-to-end
* Delist/freeze lifecycle is supported and enforced in trading flow
* Users cannot trade frozen/delisted symbols against TToken
* Lightweight call-auction mode is demonstrable for active symbols

---

### Stage 13.6 — Basket ETF Product

**Objective:**
Add a tokenized basket product (NASDAQ-style index basket) with T+0 mint/redeem settlement against TToken.

**Key Files:**

* `docs/stages/stage13.6-BasketETF.md` (new)
* `contracts/BasketToken.sol` (new)
* `contracts/BasketFactory.sol` (new)
* `contracts/BasketRouter.sol` (new)
* `scripts/ui/html/public/trade.html`
* `scripts/ui/html/public/portfolio.html`

**Approval Criteria:**

* Basket product can be created from locally defined NASDAQ symbols/weights
* Mint and redeem settle atomically (T+0) in a single transaction path
* Basket transactions are visible in wallet-scoped transaction history
* Basket positions are visible in portfolio

---

### Stage 14 — Final Verification (Invariants + Fuzz)

**Objective:**
Finalize project rigor with invariant and fuzz testing for all critical contracts and state transitions.
This stage runs on local Hardhat only.

**Key Files:**

* `test/invariants/*` (new)
* `test/fuzz/*` (new)
* `docs/verification-report.md` (new)

**Approval Criteria:**

* Critical invariants are encoded and passing
* Fuzz tests cover random user/order/product flows
* Reproducible test commands and seeds are documented
* Verification report maps each property to contract behavior
* No Sepolia deployment/testing occurs before Stage 15

---

### Stage 15 — Sepolia Deployment and Hosted App Plan

**Objective:**
Deploy contracts to Sepolia, host backend/frontend, and operate the system with environment-specific configuration and observability.

**Key Files:**

* `docs/stages/stage15-SepoliaDeployment.md` (new)
* `scripts/deploy/sepolia/*` (new)
* `deployments/sepolia.json` (new)
* `.env.sepolia.example` (new)
* `docs/deployment-sepolia.md` (new)

**Approval Criteria:**

* Full contract suite deployed to Sepolia with verified addresses
* Backend runs against Sepolia RPC with correct contract config
* Frontend hosted and connected to Sepolia backend
* End-to-end smoke test passes on public testnet
