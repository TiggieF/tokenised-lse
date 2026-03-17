# Tokenised NASDAQ Manual (Implementation Deep Dive)

## Summary

This is the full technical handover for the current repository implementation.

It is written as an implementation-truth manual (same style as `docs/merkle-dividends-deep-dive.md`) so another engineer can:
- understand each component in context,
- trace data and control flow end-to-end,
- operate and troubleshoot the system,
- continue development without reverse-engineering the codebase.

Scope is code truth from:
- `contracts/*.sol`
- `scripts/ui/html/server.js`
- `scripts/ui/html/public/*.html`
- `scripts/deploy-*.js`, `scripts/bootstrap-sepolia.sh`
- `deployments/*.json`
- `test/*.test.js`

---

## 1) System Purpose and Runtime Model

Tokenised NASDAQ is a blockchain market-infrastructure prototype with:
- tokenised equities (`EquityToken`),
- quote cash token (`TToken`),
- on-chain order matching (`OrderBookDEX`),
- backend indexing and operational APIs (`server.js`),
- browser UI for market, portfolio, trading, admin and diagnostics.

Primary design goal:
- explicit, inspectable market rules with deterministic settlement.

Current production posture:
- testnet-grade operational deployment (Sepolia),
- not legal market infrastructure,
- research/dissertation + engineering demonstration system.

---

## 2) Architecture and Data Planes

## 2.1 Planes

1. On-chain execution plane
- Solidity contracts hold economic truth for balances, orders, fills, dividends, claims, rewards, leveraged mint/unwind.

2. Off-chain query/ops plane
- `server.js` handles RPC access, indexing, aggregation, API composition, admin controls, market data fallback, gas and autotrade loops.

3. UI interaction plane
- Multi-page HTML clients call backend APIs and request wallet signatures for user-owned actions.

## 2.2 Runtime Topology

```text
Wallet User
  -> Frontend (index shell + pages)
     -> Backend API (Express)
        -> EVM RPC provider (Hardhat / Sepolia)
        -> FMP + Yahoo data APIs
        -> Persistent JSON state (indexer/autotrade/admin/dividends-merkle)
```

---

## 3) Smart Contract Deep Dive (Component by Component)

## 3.1 `TToken.sol` (Settlement Cash)

### Purpose
- Base ERC-20 quote asset used for trading, dividends, and rewards.

### Techniques Used
- `AccessControl` role gating (`DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`).
- Supply-cap enforcement.
- One-time airdrop tracking (`airdropClaimed`).

### Core Methods
- `mint(to, amount)` (minter-only)
- `airdropOnce()`
- `hasClaimedAirdrop(account)`

### Trade-offs
- Clear settlement abstraction and easy integration.
- Not equivalent to legal fiat settlement rails.

---

## 3.2 `ListingsRegistry.sol` (Canonical Symbol Directory)

### Purpose
- Canonical mapping between symbol and listed equity token address.

### Techniques Used
- Symbol normalization and keying.
- Role-gated listing writes.
- Pagination for symbol scans.

### Core Methods
- `registerListing(symbol, tokenAddr)`
- `getListing(symbol)`
- `getSymbolByToken(token)`
- `getAllSymbols()`, `getSymbols(offset, limit)`
- `isListed(symbol)`

### Operational Importance
- Backend and UI derive tradable universe from this contract.

---

## 3.3 `EquityToken.sol` + `EquityTokenFactory.sol`

### Purpose
- Per-symbol ERC-20 instrument and controlled creation process.

### Techniques Used
- Factory pattern for deterministic setup.
- Access-controlled minting (`MINTER_ROLE`).
- Snapshot ledger for historical state (`snapshot`, `balanceOfAt`, `totalSupplyAt`).

### Factory Flow
1. Create token with symbol/name.
2. Register listing in registry.
3. Assign configured roles.

### Why Snapshot Matters
- Dividends depend on historical balances at declaration time.

---

## 3.4 `PriceFeed.sol` (On-Chain Price State)

### Purpose
- Store and serve symbol price in cents + timestamp.

### Techniques Used
- Oracle role gate (`ORACLE_ROLE`).
- Freshness-window validation (`isFresh`).

### Core Methods
- `setPrice(symbol, priceCents)`
- `getPrice(symbol)`
- `setFreshnessWindow(secs)`
- `isFresh(symbol)`

### Dependency Graph
- Used by DEX quote-bounded logic and portfolio valuation paths.

---

## 3.5 `OrderBookDEX.sol` (On-Chain Matching Engine)

### Purpose
- Match and settle limit orders and quote-budget buys.

### Techniques Used
- Price-time priority.
- Escrow model for both sides.
- Partial fill support.
- Order cancellation with refund.
- Self-trade prevention.
- `ReentrancyGuard` on mutating methods.

### Core Methods
- `placeLimitOrder(equityToken, side, price, qty)`
- `buyExactQuote(equityToken, quoteWei, maxPriceCents)`
- `buyExactQuoteAtOracle(equityToken, quoteWei, maxSlippageBps)`
- `cancelOrder(orderId)`
- `getBuyOrders(token)`, `getSellOrders(token)`

### Event Model
- `OrderPlaced`
- `OrderFilled`
- `OrderCancelled`
- `QuoteBuyExecuted`
- `OracleQuoteBuyExecuted`

### Integration Notes
- Calls into `Award` via `recordTradeQty` when configured.
- Reads listing/price context via registry + feed interfaces.

---

## 3.6 `Dividends.sol` (Snapshot Dividends)

### Purpose
- Declare per-share dividends and let holders claim by snapshot state.

### Techniques Used
- Snapshot-based entitlement math.
- Epoch tracking per equity token.
- Claim lockout (`isClaimed`).

### Core Methods
- `declareDividendPerShare(...)`
- `claimDividend(...)`
- `previewClaim(...)`

---

## 3.7 `DividendsMerkle.sol` (Merkle Dividends)

### Purpose
- Scalable claim path using off-chain tree + on-chain proof verification.

### Techniques Used
- Merkle root commitments.
- Bitmap-like claimed leaf tracking.
- Left-right positional proof processing.

### Full deep-dive reference
- See `docs/merkle-dividends-deep-dive.md`.

---

## 3.8 `Award.sol` (Epoch Reward Engine)

### Purpose
- Track per-epoch traded quantity and allow winner claim.

### Techniques Used
- Time-window epoching.
- Quantity leaderboard maps.
- Tie-aware winner determination.

### Core Methods
- `recordTradeQty(trader, qtyWei)` (DEX path)
- `currentEpoch()`
- `isWinner(epochId, trader)`
- `claimAward(epochId)`

### Failure Consideration
- UI/backend must handle RPC rate limits and timing boundaries around epoch transitions.

---

## 3.9 Leveraged Stack

Contracts:
- `LeveragedTokenFactory.sol`
- `LeveragedToken.sol`
- `LeveragedProductRouter.sol`

### Purpose
- Create and run long leveraged token products (3x/5x supported in current model).

### Techniques Used
- Factory product registry.
- Router-restricted mint/burn on product token.
- Preview quote functions before mint/unwind execution.

### Core Methods
- Factory: `createLongProduct`, product lookup/list methods.
- Router: `mintLong`, `unwindLong`, `previewMint`, `previewUnwind`.

---

## 3.10 `PortfolioAggregator.sol`

### Purpose
- Read-only portfolio and valuation helpers.

### Techniques Used
- Registry symbol iteration.
- Balance + price aggregation.
- Summary and pagination methods.

### Core Methods
- `getHoldings`, `getHoldingsSlice`
- `getPortfolioSummary`
- `getTotalValue`

---

## 4) Backend Deep Dive (`scripts/ui/html/server.js`)

## 4.1 Runtime Responsibilities

`server.js` is a monolithic service that owns:
- static hosting for UI,
- RPC integration,
- market data composition,
- indexing and transaction/cashflow assembly,
- admin controls,
- dividends/award orchestration,
- leveraged APIs,
- autotrade loop,
- gas diagnostics.

This single-file design gives low-friction iteration and easy local traceability, at the cost of high coupling and larger maintenance surface.

## 4.2 RPC Wrapper and Reliability Strategy

### Technique
- Central JSON-RPC wrapper with retry/backoff.
- Explicit 429/rate-limit detection.
- `eth_sendTransaction` fallback to local signer-based send if node won’t sign.

### Signer Sources
- `TX_SIGNER_PRIVATE_KEYS`
- `DEPLOYER_PRIVATE_KEY`
- `MINTER_PRIVATE_KEY`
- optional `RPC_RELAYER_PRIVATE_KEY`

### Why this matters
- Supports both user-client-sign and server-relay execution paths.

## 4.3 External Market Data Strategy

### Providers
- Primary: FMP endpoints.
- Fallback: Yahoo quote/candles.

### Technique
- Multiple short-lived in-memory caches (quote/info/index/details).
- Degraded responses instead of hard failures where feasible.

### Benefit
- UI remains functional under partial provider instability.

---

## 5) Off-Chain Indexer Deep Dive (How It Works)

This section is the key implementation detail you requested.

## 5.1 Purpose

The indexer builds local query-optimized state for:
- orders,
- fills,
- cancellations,
- cashflows,
- transfers (optional),
- leveraged events (optional).

Without this layer, high-frequency UI queries would repeatedly scan chain logs and become slow/expensive.

## 5.2 Storage and Files

Root:
- `PERSISTENT_DATA_DIR/indexer` (default `./cache/indexer`, production often `/data/indexer`).

Files:
- `state.json`
- `orders.json`
- `fills.json`
- `cancellations.json`
- `cashflows.json`
- `transfers.json`
- `leveraged.json`
- `get-logs-chunk.json` (adaptive range memory)

`state.json` structure:
- `lastIndexedBlock`
- `latestKnownBlock`
- `lastSyncAtMs`

## 5.3 Sync Entry Points

- Background loop triggers `ensureIndexerSynced()` on interval.
- API-triggered sync from:
  - `GET /api/indexer/status`
  - `POST /api/indexer/rebuild`
  - transaction/portfolio endpoints that require fresh indexed state.

## 5.4 Bootstrapping Logic

When `lastIndexedBlock < 0`:
1. Determine `latestBlock` from chain.
2. Determine `startBlock` in this priority:
   - configured start block (`ORDERBOOK_FILLS_START_BLOCK` or `INDEXER_START_BLOCK`),
   - orderbook deployment block discovery (`eth_getCode` binary search),
   - fallback lookback (`INDEXER_BOOTSTRAP_LOOKBACK_BLOCKS`).

This design prevents scanning chain genesis on public networks.

## 5.5 Incremental Window Logic

Each run computes:
- `syncEndBlock = min(latestBlock, startBlock + INDEXER_MAX_SYNC_BLOCKS_PER_RUN - 1)`

This bounds each sync pass and avoids very long RPC windows.

## 5.6 Log Retrieval Technique

Uses `getLogsChunked(...)` with:
- dynamic chunk size,
- adaptive shrink on block-range errors,
- retry on rate-limit errors,
- persisted chunk memory in `get-logs-chunk.json`.

Indexed topics include:
- `OrderPlaced`
- `OrderFilled`
- `OrderCancelled`
- ERC20 `Transfer` (if `INDEXER_ENABLE_TRANSFERS=true`)
- leveraged mint/unwind events (if `INDEXER_ENABLE_LEVERAGED=true`)

## 5.7 Transformation Pipeline

1. Parse logs and sort by block/log index.
2. Resolve block timestamps via `eth_getBlockByNumber`.
3. Build/merge order state map.
4. Build fill records with maker/taker attribution.
5. Build cancellation rows.
6. Derive cashflows from fills/cancellations.
7. Optionally index token transfers.
8. Optionally index leveraged events.
9. Persist all JSON artifacts.
10. Update `state.json` with synced block metadata.

## 5.8 Cashflow Derivation Model

Cashflows are synthetic but deterministic from execution events:
- buy-side spend -> `TTOKEN OUT`, reason `TRADE_BUY`
- sell-side receive -> `TTOKEN IN`, reason `TRADE_SELL`
- buy cancellation refund -> `TTOKEN IN`, reason `ORDER_CANCEL_REFUND`

Wallet addresses are normalized before write/compare.

## 5.9 Rebuild Semantics

`POST /api/indexer/rebuild` does:
- clear all indexer JSON files to empty state,
- reset `lastIndexedBlock=-1`,
- trigger bounded sync wait.

Important behavior:
- endpoint can return timeout while background sync continues.
- timeout response does not always mean hard failure.

## 5.10 Common Failure Modes

1. Slow initial catch-up
- large block gap + conservative RPC limits.

2. Misconfigured start block
- too early causes long backlog.
- too late hides historical wallet events.

3. RPC saturation / 429
- sync appears stalled; progresses in bursts.

4. Ephemeral disk reset
- index state lost on restart/redeploy.

## 5.11 Operational Controls

High-impact env vars:
- `ORDERBOOK_FILLS_START_BLOCK`
- `INDEXER_START_BLOCK`
- `INDEXER_BOOTSTRAP_LOOKBACK_BLOCKS`
- `INDEXER_MAX_SYNC_BLOCKS_PER_RUN`
- `GET_LOGS_BLOCK_RANGE`
- `INDEXER_ENABLE_TRANSFERS`
- `INDEXER_ENABLE_LEVERAGED`

Recommended production posture:
- persistent disk,
- explicit `ORDERBOOK_FILLS_START_BLOCK` set to deployment-era block,
- monitor `state.json` drift (`latestKnownBlock - lastIndexedBlock`).

---

## 6) API Domains (Implementation Truth)

Route declarations are centralized in `server.js`. Main groups are:

1. Market data
- `/api/stock/:symbol`, `/api/quote`, `/api/fmp/*`, `/api/candles`

2. Permissions and admin wallets
- `/api/ui/permissions`, `/api/admin/wallets*`

3. TToken and equity operations
- `/api/ttoken/*`, `/api/equity/*`, `/api/registry/listings`

4. Trading and order management
- `/api/orderbook/limit`
- `/api/orderbook/buy-market-qty`
- `/api/orderbook/open`, `/api/orderbook/fills`
- `/api/orders/open`, `/api/orders/:orderId`, `/api/orders/cancel`

5. Indexer and transaction views
- `/api/indexer/status`, `/api/indexer/rebuild`
- `/api/txs`

6. Portfolio and reconciliation
- `/api/portfolio/positions`, `/api/portfolio/summary`, `/api/portfolio/rebuild-audit`

7. Dividends (snapshot and merkle lanes)
- `/api/dividends/*`, `/api/dividends/merkle/*`

8. Award
- `/api/award/*`

9. Leveraged
- `/api/leveraged/*`

10. Symbol lifecycle and live updates
- `/api/admin/symbols/*`, `/api/admin/price/*`, `/api/admin/live-updates*`

11. Autotrade and gas
- `/api/autotrade/*`, `/api/gas/*`

---

## 7) Frontend Deep Dive (Page Components)

UI pages are under `scripts/ui/html/public/` and mounted through `index.html`.

## 7.1 `index.html` (Shell)
- Wallet connect indicator and account state.
- Page-frame routing to all modules.
- Notification center and ticker tape.
- Admin nav visibility based on permissions.

## 7.2 `trade.html`
- Dual mode stock buy:
  - `Limit Order` mode (price + qty -> `/api/orderbook/limit`)
  - `Buy` mode (instant buy by quantity -> `/api/orderbook/buy-market-qty`)
- Leverage controls integrated in same page.
- Lifecycle lock banner handling for non-tradable symbols.

## 7.3 `sell.html`
- Manual sell panel for limit sells.
- Auto-sell removed.

## 7.4 `portfolio.html`
- Holdings, cash/stock/total cards.
- Claimable dividends table (snapshot + merkle merged lane).
- Leveraged position rows.

## 7.5 `transactions.html`
- Wallet activity feed from `/api/txs`.
- Filter modes and pagination/load-more behavior.

## 7.6 `award.html`
- Window countdown, reward amount, leaderboard, claimables.
- Handles degraded/rate-limited backend states.

## 7.7 `ttoken.html`
- Airdrop workflow.
- Equity factory panel with admin-visibility gating.

## 7.8 `admin.html`
- Admin wallet management.
- Listing/symbol lifecycle operations.
- Price/live-update controls.
- Dividend and merkle declaration controls.

## 7.9 `chart.html` and `gas.html`
- `chart.html`: market chart + live quote + info panels.
- `gas.html`: gas diagnostic rows and connection status.

---

## 8) Persistence, Environments, and Deployment

## 8.1 Key environment configuration

Reference template: `.env.sepolia.example`.

Critical vars:
- RPC: `SEPOLIA_RPC_URL`, `HARDHAT_RPC_URL`, `RPC_URL`
- network: `DEFAULT_NETWORK`, `DEPLOYMENTS_NETWORK`
- signer keys: `TX_SIGNER_PRIVATE_KEYS`, `RPC_RELAYER_PRIVATE_KEY`
- persistent root: `PERSISTENT_DATA_DIR`
- indexer controls: `ORDERBOOK_FILLS_START_BLOCK`, `INDEXER_*`, `GET_LOGS_BLOCK_RANGE`
- background loops: `ENABLE_AUTOTRADE`, `ENABLE_GAS_PACK`, poll intervals

## 8.2 Deployment files
- `deployments/localhost.json`
- `deployments/sepolia.json`

Backend fails logically if required contract addresses are missing.

## 8.3 Deployment scripts

- Stage deploy scripts: `scripts/deploy-*.js`
- Full bootstrap: `scripts/bootstrap-sepolia.sh`

Bootstrap script covers:
1. env load and chain-id check,
2. install/compile,
3. deploy contracts,
4. seed prices,
5. start server,
6. smoke API checks.

---

## 9) Testing and Verification

## 9.1 Test suite coverage (`test/*.test.js`)

- Token controls and cap: `ttoken.test.js`
- Listings and factory correctness: `listings-factory.test.js`
- Price freshness and oracle role: `pricefeed.test.js`
- DEX matching and invariants: `orderbook-dex.test.js`
- Quote/oracle bounded orders: `quote-bounded-orders.test.js`, `oracle-quote-orders.test.js`
- Dividends snapshot + merkle: `dividends.test.js`, `dividends-merkle.test.js`
- Award epochs and claims: `award.test.js`
- Leveraged flows: `leveraged-products.test.js`
- Portfolio valuation: `portfolio-aggregator.test.js`
- Sepolia deployment sanity: `sepolia-smoke.test.js`

## 9.2 What is not fully covered

- Full browser E2E for every UI state.
- Production-grade load/performance tests.
- Formal verification / external audit coverage.

---

## 10) Operations and Troubleshooting

## 10.1 Indexer-related issues

Symptoms:
- `/api/indexer/status` returns timeout while sync still in progress.
- historical tx/cashflow missing from UI.

Checklist:
1. Verify RPC health (`eth_blockNumber`).
2. Inspect indexer state file.
3. Verify start block settings.
4. Rebuild indexer if schema/logic changed.
5. Ensure persistent disk is mounted and writable.

## 10.2 Missing transaction in UI but visible on explorer

Likely causes:
- index lag,
- start block too recent,
- wallet normalization mismatch,
- rebuild not completed.

Action:
- trigger rebuild and monitor `lastIndexedBlock` progression.

## 10.3 Award countdown anomalies

Potential causes:
- RPC delays/rate-limit,
- epoch boundary timing,
- stale frontend polling state.

Use backend award endpoints directly to verify chain-derived values.

## 10.4 PM2/environment drift

Always restart with updated env:
- `pm2 restart <app> --update-env`

---

## 11) Continuation Blueprint (How Others Should Carry On)

## 11.1 Codebase reading order
1. `manual.md` (this file)
2. `docs/merkle-dividends-deep-dive.md`
3. `docs/tokenised-nasdaq-investor-strategy-summary.md`
4. `docs/decision-log-tokenised-nasdaq.md`
5. `docs/stages/*`

## 11.2 Safe change workflow
1. Modify contract/backend/frontend in small steps.
2. Add/update tests first for behavior changes.
3. Run full test suite.
4. Update deployment and env docs if behavior moved.
5. Rebuild indexer after event/schema-affecting backend changes.

## 11.3 Priority hardening roadmap
1. Split monolithic backend into modules.
2. Add structured logs + metrics + alerting.
3. Improve indexer observability and backfill tooling.
4. Migrate persistent JSON to managed DB index for scale.
5. Strengthen signer key custody and admin governance controls.

---

## 12) Techniques Used (Consolidated)

- Deterministic on-chain order matching with price-time priority.
- Escrow-based ERC-20 settlement and refunds.
- Snapshot-based historical entitlement math.
- Merkle-proof verification for scalable claims.
- AccessControl role-based governance.
- Adaptive chunked log indexing with rate-limit backoff.
- Multi-provider market data fallback with degraded responses.
- Mixed transaction model (client-sign + server-relay).
- Persistent JSON runtime state for operational continuity.
- Stage-driven iterative development with contract test coverage.

---

## 13) Final Implementation Notes

Tokenised NASDAQ is already a full-stack working system with advanced features beyond a basic DEX demo: dividends (two lanes), epoch rewards, leveraged products, local indexer, autotrade, and gas diagnostics.

The main continuation risk is not feature absence; it is operational robustness under public-network conditions (RPC limits, index lag, persistence discipline, and governance safety). This manual is therefore written to make both implementation and operations explicit so future contributors can extend the system safely.
