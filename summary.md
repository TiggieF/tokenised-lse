# Blockchain Summary (Contracts, Functions, Parameters)

This document summarizes the **on‑chain modules** implemented to date and lists the **key functions + parameters**.

---

## 1) TToken (`contracts/TToken.sol`)
**Purpose:** Stable settlement token (18dp).

**Roles**
- `DEFAULT_ADMIN_ROLE`
- `MINTER_ROLE`

**Key constants**
- `MAX_SUPPLY`
- `AIRDROP_AMOUNT`

**Key functions**
- `mint(address to, uint256 amount)`  
  **Role:** `MINTER_ROLE`  
  **Purpose:** Mint new TToken.

- `airdropOnce()`  
  **Role:** public  
  **Purpose:** One‑time airdrop to caller.

- `hasClaimedAirdrop(address account) -> bool`  
  **Role:** view  
  **Purpose:** Check if account has claimed.

---

## 2) EquityToken (`contracts/EquityToken.sol`)
**Purpose:** Equity token per listing (18dp).

**Roles**
- `DEFAULT_ADMIN_ROLE`
- `MINTER_ROLE`
- `SNAPSHOT_ROLE`

**Key functions**
- `mint(address to, uint256 amount)`  
  **Role:** `MINTER_ROLE`

- `snapshot() -> uint256 snapshotId`  
  **Role:** `SNAPSHOT_ROLE`

- `balanceOfAt(address account, uint256 snapshotId)`  
  **Role:** view  
  **Purpose:** Snapshot balance.

- `totalSupplyAt(uint256 snapshotId)`  
  **Role:** view

---

## 3) EquityTokenFactory (`contracts/EquityTokenFactory.sol`)
**Purpose:** Deploys new equity tokens and registers listings.

**Roles**
- `DEFAULT_ADMIN_ROLE`

**Key functions**
- `createEquityToken(string symbol, string name) -> address tokenAddr`  
  **Role:** admin  
  **Purpose:** Deploys EquityToken and registers in registry.

---

## 4) ListingsRegistry (`contracts/ListingsRegistry.sol`)
**Purpose:** Maps symbol ↔ token and allows discovery.

**Roles**
- `DEFAULT_ADMIN_ROLE`
- `LISTING_ROLE`

**Key functions**
- `registerListing(string symbol, string name, address tokenAddr)`  
  **Role:** `LISTING_ROLE`

- `getListing(string symbol) -> address`  
- `getListingFull(string symbol) -> (address, string, string)`  
- `isListed(string symbol) -> bool`  
- `getSymbolByToken(address token) -> string`  
- `getAllSymbols() -> string[]`  
- `getSymbols(uint256 offset, uint256 limit) -> string[]`

---

## 5) PriceFeed (`contracts/PriceFeed.sol`)
**Purpose:** Oracle price storage (cents + timestamp).

**Roles**
- `DEFAULT_ADMIN_ROLE`
- `ORACLE_ROLE`

**Key functions**
- `setPrice(string symbol, uint256 priceCents)`  
  **Role:** `ORACLE_ROLE`

- `getPrice(string symbol) -> (uint256 priceCents, uint256 timestamp)`  
- `isFresh(string symbol) -> bool`  
- `setFreshnessWindow(uint256 secs)`  
  **Role:** `DEFAULT_ADMIN_ROLE`

---

## 6) OrderBookDEX (`contracts/OrderBookDEX.sol`)
**Purpose:** Order book DEX with escrow + oracle‑assisted buys.

**Constructor**
```
OrderBookDEX(address ttoken, address registry, address priceFeed)
```

**Key structs**
- `Order { id, trader, side, price, qty, remaining, active }`
- `OrderRef { equityToken, side, index }`

**Key functions**
- `placeLimitOrder(address equityToken, Side side, uint256 priceCents, uint256 qtyWei) -> uint256 orderId`
- `cancelOrder(uint256 orderId)`
- `getBuyOrders(address equityToken) -> Order[]`
- `getSellOrders(address equityToken) -> Order[]`

**Stage 5.5**
- `buyExactQuote(address equityToken, uint256 quoteWei, uint256 maxPriceCents)`
  - IOC buy, no fee, refund leftover.

**Stage 5.6**
- `buyExactQuoteAtOracle(address equityToken, uint256 quoteWei, uint256 maxSlippageBps)`
  - Uses PriceFeed, requires `isFresh`, computes oracle max price.
  - Returns `(qtyBoughtWei, quoteSpentWei, oraclePriceCents, oracleMaxPriceCents)`.

**Stage 6 integration**
- `setAward(address awardContract)`  
  **Role:** `DEFAULT_ADMIN_ROLE`  
  **Purpose:** enable Award tracking.

---

## 7) Dividends (`contracts/Dividends.sol`)
**Purpose:** Snapshot‑based per‑share dividends.

**Constructor**
```
Dividends(address ttoken, address registry, address admin)
```

**Key functions**
- `declareDividendPerShare(address equityToken, uint256 divPerShareWei)`
  **Role:** `DEFAULT_ADMIN_ROLE`

- `claimDividend(address equityToken, uint256 epochId)`
- `previewClaim(address equityToken, uint256 epochId, address account)`
- `isClaimed(address equityToken, uint256 epochId, address account)`

---

## 8) Award (`contracts/Award.sol`)
**Purpose:** On‑chain volume tracking, reward top trader.

**Constants**
- `EPOCH_DURATION = 10` (test setting)
- `REWARD_AMOUNT = 1e18`

**Key functions**
- `recordTrade(address trader, uint256 quoteVolume)`  
  **Caller:** DEX only

- `finalizeEpoch(uint256 epochId)`  
  **Purpose:** mints reward to top trader.

- `currentEpoch()`
- `setDex(address newDex)`  
  **Role:** `DEFAULT_ADMIN_ROLE`

---

## 9) PortfolioAggregator (`contracts/PortfolioAggregator.sol`)
**Purpose:** Portfolio balances + valuation in TToken.

**Constructor**
```
PortfolioAggregator(address ttoken, address registry, address priceFeed)
```

**Key functions**
- `getTTokenBalance(address user)`
- `getHoldings(address user) -> Holding[]`
- `getHoldingsSlice(address user, uint256 offset, uint256 limit)`
- `getTotalValue(address user)`
- `getPortfolioSummary(address user) -> (cashValueWei, stockValueWei, totalValueWei)`

**Holding struct**
```
Holding {
  address token;
  string symbol;
  uint256 balanceWei;
  uint256 priceCents;
  uint256 valueWei;
}
```

---

## Demos & Scripts

Key demo scripts:
- `scripts/stage4/demo.js` (basic trade)
- `scripts/stage4/demo_account5_6.js` (trade with wallets #5/#6)
- `scripts/stage5/demo.js` (dividends)
- `scripts/stage5_5/demo.js` (oracle‑assisted IOC buy, live price)
- `scripts/stage5_6/demo.js` (oracle‑assisted IOC buy, detailed)
- `scripts/stage6/demo.js` (award tracking + finalize)

---

## Tests

Key test suites:
- `test/ttoken.test.js`
- `test/listings-factory.test.js`
- `test/pricefeed.test.js`
- `test/orderbook-dex.test.js`
- `test/dividends.test.js`
- `test/quote-bounded-orders.test.js`
- `test/oracle-quote-orders.test.js`
- `test/award.test.js`
- `test/portfolio-aggregator.test.js`
