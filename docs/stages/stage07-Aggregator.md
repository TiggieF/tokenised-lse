# Stage 7 — Portfolio Aggregator

## Objective

Aggregate portfolio values across TGBP and EquityTokens.

## Deliverables

* `PortfolioAggregator.sol`

  * Functions to return user balances and valuations
  * Pulls price data from `PriceFeed`
  * Returns total value in TGBP equivalent

## Tests

* Returns correct token counts
* PriceFeed integrated accurately
* Handles missing listings gracefully

## Approval Criteria

* Portfolio dashboard reflects accurate valuations
* Contract compiles and verified on testnet
