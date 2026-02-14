# Stage 13.6 — Tokenized Basket ETF Product (Feature 6)

## Objective

Add a tokenized NASDAQ-style basket product with mint/redeem in TToken and portfolio/transaction visibility.

---

## 1) Product Definition

- Product example: `NDX5` (top NASDAQ symbols with fixed weights)
- ERC20 basket token represents pro-rata claim on basket NAV
- Mint with TToken, redeem back to TToken
- No maker/taker fees for mint/redeem path

---

## 2) Contracts

`BasketToken.sol`
- ERC20 token for one basket product
- mint/burn restricted to router

`BasketFactory.sol`
- Creates basket tokens
- One product per basket symbol
- Stores constituent weights

`BasketRouter.sol`
- `mintBasket(symbol, ttokenInWei, minOutWei)`
- `redeemBasket(symbol, basketQtyWei, minOutWei)`
- Emits `BasketMinted` and `BasketRedeemed`

---

## 3) NAV and Weight Model

Use fixed weights at launch:

- Example:
  - AAPL 25%
  - MSFT 25%
  - NVDA 20%
  - AMZN 15%
  - TSLA 15%

NAV calculation:

- `NAV = Σ(weight_i * price_i)`
- price source priority:
  1. live quote API
  2. on-chain price feed fallback
  3. last indexed price fallback

---

## 4) T+0 Settlement Simulation (Actual Behavior)

You already have atomic same-transaction settlement on matched orders. For basket mint/redeem, preserve the same T+0 behavior:

- Mint path (single transaction):
  1. transfer TToken from user to router
  2. compute basket output from current NAV
  3. mint basket tokens to user
  4. emit event with nav and output

- Redeem path (single transaction):
  1. burn basket tokens from user
  2. compute TToken output from current NAV
  3. transfer TToken to user
  4. emit event with nav and output

Why this is "actual T+0":

- execution and settlement happen atomically in one block/transaction
- no deferred clearing queue and no settlement lag

---

## 5) Backend API

- `POST /api/basket/create` (admin)
- `GET /api/basket/list`
- `GET /api/basket/quote?symbol=NDX5&side=mint|redeem&amountWei=...`
- `POST /api/basket/mint`
- `POST /api/basket/redeem`

---

## 6) Frontend Integration

Trade page:
- add Basket tab
- select basket product
- mint/redeem forms

Portfolio page:
- add basket positions table
- show qty, avg cost, NAV, current value, unrealized PnL

Transactions page:
- include `BASKET_MINT` and `BASKET_REDEEM` rows

---

## 7) Acceptance Criteria

1. Admin creates one basket product from local NASDAQ symbols.
2. User mints basket with TToken and receives basket tokens.
3. User redeems basket and receives TToken in same tx flow.
4. Portfolio and transaction history reflect basket lifecycle.
5. Local Hardhat demo includes tx hashes and before/after balances.

