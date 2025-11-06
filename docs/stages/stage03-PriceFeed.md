# Stage 3 — PriceFeed Oracle

## Objective

Implement on-chain price feed storing latest stock price in pence and timestamp.

## Deliverables

* `PriceFeed.sol`

  * Struct: `PriceEntry { uint pricePence; uint timestamp }`
  * Mapping: `symbol → PriceEntry`
  * Role: `ORACLE_ROLE` (admin backend)
* Backend route `/admin/updatePrice` pushes price via Finnhub API

## Tests

* Only ORACLE_ROLE can call `setPrice`
* Price and timestamp update correctly
* `isFresh(symbol)` returns true if ≤ 60 s old

## Approval Criteria

* Accurate timestamp storage
* Freshness logic verified
* UI correctly reflects updates
