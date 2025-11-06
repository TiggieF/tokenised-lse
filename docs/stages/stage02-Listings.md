# Stage 2 — Listings & Factory

## Objective

Implement a factory to generate unique stock tokens and register them in a central registry.

## Deliverables

* `EquityToken.sol` — ERC-20 implementation for stocks
* `EquityTokenFactory.sol` — deploys new tokens, assigns MINTER_ROLE
* `ListingsRegistry.sol` — maps ticker symbol → token address, prevents duplicates

## Functions

* `createEquityToken(symbol, name)` (admin only)
* `getListing(symbol)` returns token address
* Events: `StockListed(symbol, tokenAddr)`, `StockUnlisted(symbol)`

## Tests

* Factory deploys unique token per symbol
* Registry accurately resolves addresses
* Access control enforced

## Approval Criteria

* Verified on local network
* All tests pass and events emitted correctly
