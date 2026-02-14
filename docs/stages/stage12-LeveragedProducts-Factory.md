# Stage 12 — Leveraged Products Factory (TSLA5L, NVDA3L, etc.)

## 12.0 Purpose

Introduce exchange-traded leveraged tokens for listed equities, with lifecycle:

- product deployment via factory
- mint leveraged exposure using TToken
- unwind position
- burn leveraged tokens on close
- settle output in TToken

No maker/taker fees in this stage, per project requirement.

---

## 12.1 Scope

1. Product contracts and factory.
2. Backend endpoints for listing, mint, unwind.
3. UI support in trade and portfolio.
4. Indexer integration for leveraged lifecycle transactions.

---

## 12.2 Product Model

## 12.2.1 Symbol format

Use deterministic symbols:

- Long: `<BASE><LEVERAGE>L`, example `TSLA5L`

For this stage, implement long products only.

## 12.2.2 Eligibility

Leveraged products can be created only for symbols already listed in `ListingsRegistry`.

Factory validation:

- `registry.isListed(baseSymbol) == true`
- `leverage` in allowed set: `3, 5`

## 12.2.3 Pricing approach

For demo realism with manageable complexity:

- Mint and unwind priced off current base market price.
- Net Asset Value modeled as:
  - `NAV = collateral + exposurePnL`
- Exposure simulated through deterministic on-chain formula using indexed entry price and current price.

---

## 12.3 Contract Design

## 12.3.1 `LeveragedToken.sol` (ERC20)

State:

- `baseSymbol`
- `baseToken` (equity token address)
- `leverage`
- `factory`
- `router`

Core behavior:

- mint/burn callable only by router
- standard ERC20 balances for portfolio visibility

## 12.3.2 `LeveragedTokenFactory.sol`

Responsibilities:

- create product token contracts
- map product symbol to token address
- ensure one product per (`baseSymbol`, `leverage`, `direction`)

Key functions:

- `createLongProduct(baseSymbol, leverage) returns (productToken)`
- `getProduct(baseSymbol, leverage)`
- `isProductListed(productSymbol)`

## 12.3.3 `LeveragedProductRouter.sol`

Responsibilities:

- user-facing mint/unwind entrypoint
- TToken custody and settlement
- event emission for indexer and portfolio rebuild

Key functions:

- `mintLong(productToken, ttokenInWei, minProductOutWei)`
- `unwindLong(productToken, productQtyWei, minTTokenOutWei)`

Events:

- `LeveragedMinted(user, productToken, baseSymbol, leverage, ttokenInWei, productOutWei, navCents)`
- `LeveragedUnwound(user, productToken, baseSymbol, leverage, productInWei, ttokenOutWei, navCents)`

Burn behavior:

- unwind must burn `productInWei` from user.
- after full unwind and zero supply, token contract remains deployed but user position disappears.

---

## 12.4 Airdrop Behavior

Required behavior from request:

- user can receive initial TToken airdrop
- user can mint leveraged tokens
- when user unwinds/sells leveraged position:
  - leveraged token amount is burned
  - TToken is received back

Clarification for implementation:

- "make token disappear" should mean user balance reaches zero after burn, not self-destructing product contract.

---

## 12.5 Backend API

## 12.5.1 Product admin/listing

- `POST /api/leveraged/products/create`
  - body: `{ "baseSymbol":"TSLA", "leverage":5 }`

- `GET /api/leveraged/products`
  - list all enabled products

## 12.5.2 User actions

- `POST /api/leveraged/mint`
  - body: `{ "wallet":"0x...", "productSymbol":"TSLA5L", "ttokenInWei":"...", "minOutWei":"..." }`

- `POST /api/leveraged/unwind`
  - body: `{ "wallet":"0x...", "productSymbol":"TSLA5L", "qtyWei":"...", "minOutWei":"..." }`

- `GET /api/leveraged/quote`
  - preview mint/unwind outputs

---

## 12.6 Frontend UX Requirements

## 12.6.1 Trade page

Add leveraged product panel:

- base symbol selector (from listed equities)
- leverage selector (`3x`,`5x`)
- product symbol preview
- mint form
- unwind form
- expected output preview

## 12.6.2 Portfolio page

Add "Leveraged Positions" table:

- product symbol
- qty
- avg entry NAV
- current NAV
- current value
- unrealized PnL

## 12.6.3 Transactions page integration

Show leveraged lifecycle entries:

- `LEVERAGE_MINT`
- `LEVERAGE_UNWIND`
- `LEVERAGE_BURN`

---

## 12.7 Indexer Extensions

Add handlers for `LeveragedMinted` and `LeveragedUnwound`.

Derived records:

- wallet cash out/in in TToken
- leveraged inventory delta
- realized PnL on unwind

---

## 12.8 Acceptance Scenarios

1. Admin creates `TSLA5L`.
2. User receives TToken airdrop.
3. User mints `TSLA5L` with part of TToken.
4. Product position appears in portfolio and transactions.
5. User unwinds all `TSLA5L`.
6. Product balance becomes zero and TToken is returned.
7. Transactions show mint and unwind entries with tx hashes.

---

## 12.9 Out of Scope

- dynamic funding rates
- liquidation engines

These can be optional extension items if time remains.
