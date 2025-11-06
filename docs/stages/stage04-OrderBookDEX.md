# Stage 4 — OrderBookDEX

## Objective

Develop decentralised order book allowing limit orders, partial fills, and cancellation.

## Deliverables

* `OrderBookDEX.sol`

  * Struct `Order { id, trader, side, price, qty, remaining, active }`
  * Separate order arrays per trading pair
  * Matching algorithm supports partial fills
  * Fee: 1 ppm on taker trades
  * Cancel function restores remaining volume
* `test/stage4_OrderBookDEX.test.js`

## Tests

* Partial fills processed correctly
* Fee deducted and sent to FeePool
* Order cancellation works
* Balance conservation verified

## Approval Criteria

* All unit tests pass
* Partial-fill logic correct under multiple orders
