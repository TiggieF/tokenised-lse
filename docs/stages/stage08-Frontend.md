# Stage 8 — Frontend Integration (Detailed Plan)

## Objective

Deliver a complete frontend that connects to the on‑chain system and supports:
- wallet connection
- market discovery
- oracle‑assisted trading
- portfolio valuation
- dividends
- award tracking
- admin tooling (gated to Admin wallet)

---

## 8.1 Fixed Admin Wallet (permission gating)

**Primary admin wallet is hard‑coded to Account #16**:

- `0x2546BcD3c84621e976D8185a91A922aE77ECEc30`

Frontend must:
- Detect the connected wallet address.
- If it matches the hard‑coded admin, show Admin tabs and actions.
- Otherwise, **also allow** any address that has on‑chain admin rights.

**Allow additional admins:**
- Check `hasRole(DEFAULT_ADMIN_ROLE, wallet)` on one of the admin‑gated contracts
  (e.g., `Dividends` or `Award`) and treat that wallet as admin in the UI.

No backend is required for admin recognition; it is purely client‑side.

---

## 8.2 Pages (design all pages)

### 1) **Landing / Dashboard**
Purpose: high‑level overview for connected wallet.
Components:
- Wallet connect status + network badge
- Total portfolio value (from PortfolioAggregator)
- Cash value (TToken)
- Stock value (sum of equities)
- Recent price movers (top 3 from PriceFeed)

### 2) **Market / Listings**
Purpose: discover tradable equities.
Components:
- Table of all listings (symbol, name)
- Live price + freshness indicator
- Search / filter
- Click → Stock Detail

### 3) **Stock Detail**
Purpose: per‑stock analysis + trading.
Components:
- Candle chart (existing)
- Stock info + live price
- Order book snapshot (top bids/asks)
- Oracle‑assisted buy panel
- Limit sell panel (if enabled)

### 4) **Trade / Order Book**
Purpose: full trading interface.
Components:
- Buy/sell order book
- Recent fills
- Oracle‑buy widget (spend exact TToken)
- Limit order widget (optional)

### 5) **Portfolio**
Purpose: holdings + valuation.
Components:
- Holdings table (token, balance, price, value)
- Cash / stock / total summary

### 6) **Dividends**
Purpose: claim + admin declare.
Components:
- Dividend epochs per symbol
- Claimable amount preview
- Claim button
- Admin‑only “Declare Dividend” form

### 7) **Award**
Purpose: reward transparency.
Components:
- Current epoch ID
- Current top trader + volume
- Past winners table
- Admin/keeper “Finalize Epoch” button (optional)

### 8) **Admin Console (gated)**
Visible only if wallet == Admin address.
Components:
- List new EquityToken
- Update PriceFeed manually
- Grant roles (oracle/minter/snapshot)
- Contract address registry display

---

## 8.3 Frontend ↔ Contract Map

**ListingsRegistry**
- `getAllSymbols()` / `getListing(symbol)`

**PriceFeed**
- `getPrice(symbol)` / `isFresh(symbol)`

**OrderBookDEX**
- `placeLimitOrder(...)`
- `buyExactQuoteAtOracle(...)`
- `getBuyOrders(...)` / `getSellOrders(...)`

**PortfolioAggregator**
- `getHoldings(...)`
- `getPortfolioSummary(...)`

**Dividends**
- `previewClaim(...)`
- `claimDividend(...)`
- `declareDividendPerShare(...)` (admin)

**Award**
- `currentEpoch()`
- `topTraderByEpoch(epochId)`
- `finalizeEpoch(epochId)` (keeper/admin)

---

## 8.4 Backend (minimal)

Backend is optional for UI but recommended for:
- PriceFeed updater (oracle)
- Award finalizer (cron)

Stage 8 does **not** require backend development unless you want automation.

---

## 8.5 Acceptance Criteria

- All pages render correctly and load on mobile + desktop
- Wallet connect works
- Admin gating based on Account #16
- Core flows:
  - Oracle buy
  - Portfolio valuation
  - Dividend claim
  - Award view
  - Admin actions (only for admin wallet)
