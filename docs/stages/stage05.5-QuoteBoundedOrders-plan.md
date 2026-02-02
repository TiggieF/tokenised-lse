# Stage 5.5 — Quote‑Bounded Orders (On‑Chain “Spend Exactly X TToken”)

This stage adds a **new on‑chain taker order type** to your existing `OrderBookDEX` so a user can buy equity by specifying an **exact quote budget** in `TToken` (e.g., “spend exactly 1 TToken”), with an explicit **max price** to bound slippage.

It is intentionally **IOC (Immediate‑Or‑Cancel)**: it executes against the current sell book and **does not** rest on the order book.

---

## 5.5.0 Objective

Enable users to execute a buy that is **bounded by a quote budget** (`quoteWei`) rather than a base quantity (`qtyWei`), while preserving:

- Best price first + FIFO at same price (price‑time priority)
- Partial fills
- Deterministic budget enforcement (`quoteSpentWei <= quoteWei`)
- Refund of unspent quote
- No transaction fees (aligned with your Stage 4 change)

---

## 5.5.1 Locked conventions (same as Stage 4)

- `TToken` uses **18 decimals** (wei units)
- `EquityToken` uses **18 decimals** (wei-share units)
- Prices are integer **2dp** quote units: `priceCents`
  - Example: $123.45 → `12345`
- Trade value math (critical):
  - `tradeQuoteWei = (fillQtyWei * priceCents) / 100`

---

## 5.5.2 Feature scope (locked)

✅ Implement **BUY exact quote only**  
- No “sell for exact quote” in this stage.

✅ IOC semantics  
- The order executes immediately and does not create a resting limit order.

✅ Slippage control via user‑supplied `maxPriceCents`  
- Only matches sells where `sell.priceCents <= maxPriceCents`.

✅ Escrow the quote upfront and refund leftover  
- Transfer `quoteWei` into the DEX first.
- After matching, refund `quoteWei - quoteSpentWei`.

✅ No fees  
- Stage 5.5 remains fee‑free to match your current “no transaction fee” model.

✅ If nothing fills, revert  
- If `qtyBoughtWei == 0`, revert `"OrderBookDEX: no fill"` (atomic; user funds unchanged).

---

## 5.5.3 Deliverables

### Contracts
- **Modify** `OrderBookDEX.sol`
  - Add new function `buyExactQuote(...)`
  - Add new event `QuoteBuyExecuted(...)`
  - Add internal helper(s) for best sell selection (reuse existing)

### Tests
- `test/stage5_5_QuoteBoundedOrders.test.js` *(recommended filename)*  
  or extend your existing `stage4_OrderBookDEX.test.js` with a new describe block:
  - `describe("Stage 5.5 — buyExactQuote", ...)`

### Docs
- This plan file: `stage05.5-QuoteBoundedOrders-plan.md`

---

## 5.5.4 Public API

### 5.5.4.1 `buyExactQuote`

```solidity
function buyExactQuote(
  address equityToken,
  uint256 quoteWei,        // budget in TToken wei (18dp)
  uint256 maxPriceCents    // max acceptable ask price (2dp integer)
) external nonReentrant returns (uint256 qtyBoughtWei, uint256 quoteSpentWei);
```

#### Validations (must)
- `equityToken != address(0)`
- `quoteWei > 0`
- `maxPriceCents > 0`
- `TToken.allowance(msg.sender, address(this)) >= quoteWei` (or rely on `transferFrom` revert)

#### Effects (high level)
1. Pull `quoteWei` from user into DEX escrow
2. Match against best eligible sell orders (lowest price first, FIFO)
3. Stop when:
   - budget is fully used, OR
   - no eligible sells exist, OR
   - remaining budget is too small to buy any further qty (rounding)
4. Refund unspent quote
5. If bought nothing, revert (atomic)

---

## 5.5.5 Matching algorithm (detailed)

### 5.5.5.1 Definitions
- `remainingQuoteWei` — quote budget remaining to spend
- `qtyBoughtWei` — total equity acquired
- Best eligible sell order is the active sell with:
  - smallest `priceCents` such that `priceCents <= maxPriceCents`
  - if ties on price, smallest array index (FIFO)

### 5.5.5.2 Affordable quantity at a given price
At each step, given the current best ask `askPriceCents`, compute the maximum quantity you can afford:

```text
maxQtyWei = (remainingQuoteWei * 100) / askPriceCents
```

- This uses floor division.
- If `maxQtyWei == 0`, you cannot buy even 1 wei-share at that price → stop.

### 5.5.5.3 Fill sizing
Let `makerRemaining = maker.remaining`.

```text
fillQtyWei = min(maxQtyWei, makerRemaining)
```

### 5.5.5.4 Quote spent for the fill
```text
tradeQuoteWei = (fillQtyWei * askPriceCents) / 100
```

Update:
```text
remainingQuoteWei -= tradeQuoteWei
qtyBoughtWei += fillQtyWei
```

### 5.5.5.5 Settlement (no fee)
For each fill:
- Transfer `fillQtyWei` equity token from DEX escrow → taker
- Transfer `tradeQuoteWei` TToken from DEX escrow → maker
- Update maker order remaining/active as usual

### 5.5.5.6 End condition and refund
At the end:
- `quoteSpentWei = quoteWei - remainingQuoteWei`
- Refund `remainingQuoteWei` to taker

If `qtyBoughtWei == 0`, revert `"OrderBookDEX: no fill"` (refund happens automatically due to revert).

---

## 5.5.6 Data and state impact

This stage **should not** introduce a new order struct or persistent state for quote orders.
It reuses existing sell book arrays and matching helpers.

You will add:
- a new event (see below)
- a new public function
- possibly one or two internal helpers

---

## 5.5.7 Events

Add a new event specifically for quote‑bounded orders (recommended):

```solidity
event QuoteBuyExecuted(
  address indexed taker,
  address indexed equityToken,
  uint256 quoteBudgetWei,
  uint256 quoteSpentWei,
  uint256 qtyBoughtWei,
  uint256 maxPriceCents
);
```

Emit this once per call, after completing matching and refund.

Notes:
- Individual fills are already observable via your existing `OrderFilled` event(s).
- This summary event helps UI/indexers attribute “spent exactly X” behavior per transaction.

---

## 5.5.8 Security requirements

- `nonReentrant` on `buyExactQuote`
- Use `SafeERC20` for all ERC-20 transfers
- Follow CEI ordering where possible:
  - Update order state before external transfers when safe
- Avoid unbounded loops:
  - Loop is bounded by the number of eligible sell orders and by `remainingQuoteWei` decreasing
  - Stop if `maxQtyWei == 0` to prevent infinite loops on dust budgets

---

## 5.5.9 Test plan (comprehensive)

Create a dedicated test suite for Stage 5.5.

### 5.5.9.1 Fixture setup
- Deploy `TToken`
- Deploy `ListingsRegistry + EquityTokenFactory`
- Create an equity token (e.g., AAPL)
- Deploy `OrderBookDEX(ttoken)` (or your constructor args)
- Mint:
  - TToken to taker(s)
  - Equity tokens to maker(s)
- Approvals:
  - makers approve equity to DEX
  - takers approve TToken to DEX

### 5.5.9.2 Tests

#### Test A — Budget respected + refund correct
- Maker sells enough liquidity under maxPrice
- Taker calls `buyExactQuote(quoteWei=1e18, maxPriceCents=...)`
Assertions:
- `quoteSpentWei <= 1e18`
- `takerFinalQuote = takerInitialQuote - quoteSpentWei`
- `refundWei = 1e18 - quoteSpentWei` returned to taker
- `qtyBoughtWei > 0`
- DEX ends with no residual quote beyond what is needed for in-flight settlements (should net to 0 if fully refunded)

#### Test B — Partial fill due to limited liquidity
- Only small sell liquidity exists under maxPrice
- Taker budget is larger
Assertions:
- `qtyBoughtWei` equals total available maker liquidity
- `quoteSpentWei` equals computed value for that liquidity
- leftover quote fully refunded

#### Test C — Stops when remainingQuote too small to buy any further qty
- Construct a case where after some fills:
  - `remainingQuoteWei * 100 < bestAskPriceCents`
Thus `maxQtyWei == 0`
Assertions:
- loop terminates
- remaining quote refunded
- no over-spend

#### Test D — Best price then FIFO
- Place sells:
  - id1 @ 10100
  - id2 @ 10000
  - id3 @ 10000 (later)
- Call `buyExactQuote` with budget sufficient to consume > 1 order
Assertions:
- fills occur in order id2 → id3 → id1
- (best price first, FIFO at same price)

#### Test E — Revert when no eligible sells
- All sell orders have price > maxPriceCents
- Call `buyExactQuote`
Assertions:
- tx reverts `"OrderBookDEX: no fill"`
- taker quote balance unchanged

#### Test F — Conservation (quote + equity)
Track balances across:
- taker
- makers
- DEX
Before and after:
- Total TToken conserved (no fees)
- Total equity conserved
- DEX does not “leak” balances

#### Test G — Event emitted
Assert `QuoteBuyExecuted` emitted with:
- taker
- equityToken
- quoteBudgetWei
- quoteSpentWei
- qtyBoughtWei
- maxPriceCents

---

## 5.5.10 Approval criteria

Stage 5.5 is complete when:

- ✅ Quote budget constraint is enforced (`quoteSpentWei <= quoteWei`)
- ✅ Unspent quote is refunded correctly
- ✅ Price-time priority preserved during matching
- ✅ Partial fills behave correctly
- ✅ Reverts cleanly on no-fill cases
- ✅ Balances conserved (no fees)
- ✅ Event emitted for UI/indexing

---

## 5.5.11 Notes: relation to PriceFeed

This stage does **not** depend on the PriceFeed for execution correctness.
The user may use PriceFeed off-chain to pick a reasonable `maxPriceCents`, but the DEX matches purely against the on-chain sell book.

This separation keeps:
- oracle risk decoupled from execution,
- order book as the source of executable price.

