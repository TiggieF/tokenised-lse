# Stage 5 — Dividends

## Objective

Enable admin to declare dividends for stock tokens, paid in TGBP proportionally to holders.

## Deliverables

* `Dividends.sol`

  * `declareDividend(token, amount)`
  * Snapshot balance mapping
  * Users claim via `claimDividend(token, epoch)`
* Event: `DividendDeclared(token, amount)`

## Tests

* Snapshot captures balances accurately
* Payouts proportional to ownership
* Prevent double claims
* Handles zero-balance gracefully

## Approval Criteria

* Verified distribution correctness
* Events emitted and no reentrancy issues
