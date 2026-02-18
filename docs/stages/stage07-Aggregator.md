# Stage 7 — Portfolio Aggregator (On-Chain Read-Only Valuation, 10 Stocks Max)

This stage adds a **read-only on-chain aggregator** that returns a user’s portfolio balances and valuations in **TToken** using **PriceFeed** data.

> **Important:** The contract does **not** “detect” a wallet.  
> The **frontend** (MetaMask / wallet provider) supplies the user’s address and calls the contract with that address.  
> **No backend is required** for wallet identification or for periodic refresh/polling.

---

## 7.0 Objective

Given a user wallet address, return:

- `TToken` balance
- Each `EquityToken` balance
- Each `EquityToken` valuation in `TToken`
- Total portfolio value in `TToken`

All valuations use:
- **18-decimal** ERC-20 units for balances
- **2-decimal `priceCents`** oracle prices from `PriceFeed`

---

## 7.1 How the user wallet is recognized

### Frontend (MetaMask / wallet provider)
1. User connects their wallet in the browser.
2. Frontend reads the selected address (e.g., `0xabc...`) via `ethers` or `viem`.
3. Frontend calls `PortfolioAggregator` with that address.

### On-chain
The contract only sees the address passed in as a function argument. It does not know “who the user is” unless given an address.

✅ No backend required for wallet identification.

---

## 7.2 Locked conventions

- `TToken`: 18 decimals
- `EquityToken`: 18 decimals
- `PriceFeed`: price is **cents (2dp)** stored as `priceCents`
- **Valuation formula**:
  ```text
  equityValueWei = (equityBalanceWei * priceCents) / 100
  ```

---

## 7.3 Scope / assumptions (locked)

- Max listed equities for this prototype: **10 stocks**
- Therefore:
  - No pagination needed in the aggregator API
  - Returning the entire holdings array is safe for demo and tests

---

## 7.4 Dependencies

The aggregator requires:

- `ListingsRegistry` (to discover listed equities)
- `PriceFeed` (to get `priceCents` and timestamp per symbol)
- `TToken` (to get the base token balance)

### Required registry capability
Because the registry maps `symbol -> token`, the aggregator needs symbol enumeration:

- `string[] public listedSymbols;`
- `function getAllSymbols() external view returns (string[] memory)`

(Or equivalent getter exposing the stored list.)

---

## 7.5 Contract deliverable

### `PortfolioAggregator.sol`

Constructor dependencies:
- `TToken ttoken`
- `ListingsRegistry registry`
- `PriceFeed priceFeed`

The contract is **purely read-only** (no writes, no events required).

---

## 7.6 Public API

```solidity
struct Holding {
  address token;
  string symbol;

  uint256 balanceWei;

  uint256 priceCents;
  uint256 priceTimestamp;   // from PriceFeed
  bool isFresh;             // computed using PriceFeed.isFresh(symbol)

  uint256 valueWei;         // (balanceWei * priceCents) / 100, or 0 if stale
}

function getTTokenBalance(address user) external view returns (uint256);

function getHoldings(address user) external view returns (Holding[] memory);

function getTotalValue(address user) external view returns (uint256 totalWei);
```

---

## 7.7 Execution logic

For each listed symbol:

1. `token = registry.getListing(symbol)`
2. `balanceWei = ERC20(token).balanceOf(user)`
3. `(priceCents, priceTimestamp) = priceFeed.getPrice(symbol)`
4. `isFresh = priceFeed.isFresh(symbol)`
5. If `isFresh == true`:
   ```text
   valueWei = (balanceWei * priceCents) / 100
   ```
   else:
   - `valueWei = 0`
   - keep returning `priceTimestamp` so the UI can show “stale” age.

Total portfolio value:
- sum of all `Holding.valueWei`
- plus `TToken.balanceOf(user)`

---

## 7.8 Freshness handling (locked UX-friendly)

**Lenient (recommended for UX):**
- If a symbol is stale:
  - return `isFresh = false`
  - return `priceCents` + `priceTimestamp` as stored
  - return `valueWei = 0`
- Frontend displays: **“stale (last updated …)”** using `priceTimestamp`.

No revert on stale prices.

---

## 7.9 Frontend integration (mandatory for smooth UX)

### 7.9.1 Account switching
Frontend must subscribe to wallet events and refetch portfolio:

- `accountsChanged` → update the connected address and refetch holdings
- `chainChanged` → refetch or reload (recommended) to avoid wrong-network confusion

### 7.9.2 Refresh cadence
The frontend may refresh automatically (polling) without a backend:

- Example: refresh every **5 seconds** on localhost demos
- On public RPCs you may choose 10–15 seconds to avoid rate limits

This is implemented purely as repeated read-only RPC calls to the aggregator.

---

## 7.10 Tests (required)

Create `test/stage7_PortfolioAggregator.test.js`.

1. **Correct balances**
   - TToken balance matches
   - Equity balances match for each listed token

2. **Price integration**
   - Uses `PriceFeed.priceCents` correctly
   - Value computed as `(balanceWei * priceCents) / 100`

3. **Stale price handling**
   - When stale, `isFresh == false`, `valueWei == 0`
   - Timestamp returned matches PriceFeed stored timestamp

4. **Total value**
   - equals `ttokenBalance + sum(valueWei over holdings)`

---

## 7.11 Approval criteria

- Aggregator returns accurate per-token balances and valuations
- Total portfolio value matches expected sum
- Frontend works with MetaMask by passing the connected wallet address
- Account/network switching triggers UI refresh via subscriptions
- No backend required for wallet detection or periodic refresh
