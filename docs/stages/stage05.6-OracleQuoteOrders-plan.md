# Stage 5.6 — Oracle-Assisted Execution (IOC Oracle-Priced Buy, Book as Liquidity)

Stage 5.6 adds a **PriceFeed-assisted convenience entrypoint** to your order book DEX so users can buy with an **exact TToken budget** while the contract **pulls a live oracle price** to derive a safe `maxPriceCents` automatically.

**Critical design principle (locked):**
- The **order book remains the execution price source**.
- The oracle is used only to:
  - compute a **slippage-bounded max price** for the taker, and
  - enforce **freshness** for oracle-dependent calls.

This preserves the integrity of your limit-order order book while providing “live price convenience.”

---

## 5.6.0 Objective

Enable a user to execute:

> “Spend exactly `quoteWei` TToken to buy this equity, using the current oracle price as a reference, with slippage protection.”

by adding an oracle-assisted wrapper around Stage 5.5’s:

- `buyExactQuote(equityToken, quoteWei, maxPriceCents)`

---

## 5.6.1 Locked conventions (unchanged)

- `TToken`: 18 decimals
- `EquityToken`: 18 decimals
- Oracle/book price format: `priceCents` (2dp integer)
- Quote value math: `tradeQuoteWei = (fillQtyWei * priceCents) / 100`

---

## 5.6.2 Final design choices (locked)

### Scope
✅ **Only a new IOC oracle-assisted order** uses PriceFeed.  
❌ Do **not** apply oracle pricing to all limit-order matches.

### Staleness
✅ Require freshness and **revert if stale**:
- `require(priceFeed.isFresh(symbol), "OrderBookDEX: stale price");`

### Price source
✅ Use:
- `PriceFeed.getPrice(symbol) -> (priceCents, timestamp)`
- Use `priceCents` as the oracle reference price.

### Listings mapping
✅ DEX depends on `ListingsRegistry` for symbol lookup:
- add `tokenToSymbol[token]` in `ListingsRegistry` and a getter.

### Order prices
✅ Maker order prices remain meaningful and act as **eligibility bounds**:
- For oracle-assisted buy: fill asks where `ask.priceCents <= oracleMaxPriceCents`.

---

## 5.6.3 Dependencies / prerequisites

### 5.6.3.1 Stage 5.5 must exist
Required existing function:
- `buyExactQuote(equityToken, quoteWei, maxPriceCents)`

Stage 5.6 is implemented as a wrapper around this.

### 5.6.3.2 ListingsRegistry reverse mapping
Add to `ListingsRegistry.sol`:
- `mapping(address => string) public tokenToSymbol;`
- `function getSymbolByToken(address token) external view returns (string memory)`

Populate in `registerListing(symbol, name, tokenAddr)`:
- `tokenToSymbol[tokenAddr] = symbol`

### 5.6.3.3 OrderBookDEX constructor dependency update
OrderBookDEX must know:
- `ListingsRegistry registry`
- `PriceFeed priceFeed`

Either:
- add them to the constructor (recommended), or
- add admin-only setters (less clean).

This plan assumes **constructor injection**.

---

## 5.6.4 Deliverables

### Contracts
- Modify `OrderBookDEX.sol`
  - store `registry` + `priceFeed`
  - add `buyExactQuoteAtOracle(...)`
  - add event `OracleQuoteBuyExecuted(...)`
- Modify `ListingsRegistry.sol`
  - implement `tokenToSymbol` reverse mapping + getter

### Tests
- `test/oracle-quote-orders.test.js`

### Docs
- This plan file: `stage05.6-OracleQuoteOrders-plan.md`

---

## 5.6.5 New public API

### 5.6.5.1 `buyExactQuoteAtOracle` (primary)

```solidity
function buyExactQuoteAtOracle(
  address equityToken,
  uint256 quoteWei,         // TToken budget (18dp)
  uint256 maxSlippageBps    // 1 bps = 0.01%
) external nonReentrant returns (uint256 qtyBoughtWei, uint256 quoteSpentWei, uint256 oraclePriceCents);
```

#### Inputs
- `equityToken`: equity token being purchased
- `quoteWei`: quote budget in TToken wei
- `maxSlippageBps`: slippage bound relative to oracle price
  - e.g., 50 = 0.50%, 100 = 1.00%, 200 = 2.00%

#### Validations
- `equityToken != address(0)`
- `quoteWei > 0`
- resolve `symbol` via registry, require non-empty
- require `priceFeed.isFresh(symbol)`
- require oracle `priceCents > 0`

#### Derived values
1) `(oraclePriceCents, ) = priceFeed.getPrice(symbol)`
2) `oracleMaxPriceCents = oraclePriceCents * (10000 + maxSlippageBps) / 10000`

#### Execution
- Call the Stage 5.5 IOC path with:
  - `maxPriceCents = oracleMaxPriceCents`
- Return:
  - `(qtyBoughtWei, quoteSpentWei, oraclePriceCents)`

#### No-fill behavior
- If Stage 5.5 would revert `"OrderBookDEX: no fill"`, this wrapper also reverts.

---

## 5.6.6 Detailed flow

1) **Resolve symbol**
- `symbol = registry.getSymbolByToken(equityToken)`
- `require(bytes(symbol).length > 0, "OrderBookDEX: unknown token");`

2) **Freshness guard**
- `require(priceFeed.isFresh(symbol), "OrderBookDEX: stale price");`

3) **Read oracle price**
- `(oraclePriceCents, ) = priceFeed.getPrice(symbol)`
- `require(oraclePriceCents > 0, "OrderBookDEX: bad price");`

4) **Compute max price bound**
- `oracleMaxPriceCents = oraclePriceCents * (10000 + maxSlippageBps) / 10000`

5) **Execute IOC**
- internally call the same matching routine used by:
  - `buyExactQuote(equityToken, quoteWei, oracleMaxPriceCents)`

6) **Emit summary event**
- `OracleQuoteBuyExecuted(...)`

---

## 5.6.7 Events

```solidity
event OracleQuoteBuyExecuted(
  address indexed taker,
  address indexed equityToken,
  string symbol,
  uint256 quoteBudgetWei,
  uint256 quoteSpentWei,
  uint256 qtyBoughtWei,
  uint256 oraclePriceCents,
  uint256 oracleMaxPriceCents,
  uint256 maxSlippageBps
);
```

Emit once per `buyExactQuoteAtOracle` call.

---

## 5.6.8 Security and correctness requirements

- `nonReentrant` on `buyExactQuoteAtOracle`
- Use `SafeERC20` transfers inside underlying Stage 5.5 path
- Freshness enforced for oracle-dependent path
- Slippage bound enforced through `oracleMaxPriceCents`
- No fees
- Atomic revert if no fill
- Conservation: quote + equity conserved across maker/taker/dex

---

## 5.6.9 Test plan

Create `test/oracle-quote-orders.test.js`.

### 5.6.9.1 Fixture setup
- Deploy:
  - `TToken`
  - `ListingsRegistry`
  - `EquityTokenFactory` + create `AAPL`
  - `PriceFeed`
  - `OrderBookDEX(ttoken, registry, priceFeed)`
- Register listing `AAPL` and ensure `tokenToSymbol[AAPL_token] == "AAPL"`
- Set oracle role on PriceFeed and set `AAPL` price
- Create sell book liquidity (makers place asks)
- Seed taker with TToken and approve DEX

### 5.6.9.2 Tests

#### Test A — Oracle max bound filters asks
- Oracle price = 10000
- maxSlippageBps = 0 → oracleMax = 10000
- Asks at 9990 and 10010
- Expect fills only at 9990, skip 10010
- Assert refund correctness and spent <= budget

#### Test B — Slippage expands eligibility
- Oracle price = 10000
- maxSlippageBps = 200 → oracleMax = 10200
- Ask at 10150 becomes eligible
- Expect it to fill

#### Test C — Revert when stale
- Ensure `isFresh("AAPL") == false` (advance time or set timestamp old)
- Expect revert `"OrderBookDEX: stale price"`

#### Test D — Unknown token
- Call with token not listed / symbol missing
- Expect revert `"OrderBookDEX: unknown token"`

#### Test E — No-fill revert
- Oracle fresh, but no asks <= oracleMax
- Expect revert `"OrderBookDEX: no fill"` and balances unchanged

#### Test F — Conservation
- Total TToken conserved (spent moved to makers, remainder refunded)
- Total equity conserved

#### Test G — Event emitted
- Assert `OracleQuoteBuyExecuted` emitted with expected fields

---

## 5.6.10 Approval criteria

Stage 5.6 is complete when:

- ✅ `equityToken -> symbol` lookup works (registry reverse mapping)
- ✅ Stale oracle causes revert
- ✅ Slippage bound correctly gates eligible asks
- ✅ IOC buy spends up to budget and refunds remainder
- ✅ No-fill reverts atomically
- ✅ Conservation holds
- ✅ Oracle summary event emitted

---

## 5.6.11 Notes on “oracle-priced matching”

This stage intentionally avoids repricing maker orders at the oracle price.
If you force settlement at oracle price regardless of maker price, you no longer have an order book market and you introduce severe maker adverse selection.
This plan provides oracle convenience while preserving the order book’s pricing mechanism.
