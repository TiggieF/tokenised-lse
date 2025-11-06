# Stage 8 — Frontend Integration

## Objective

Implement full user interface matching Yahoo Finance style and connect it to contracts.

## Deliverables

* `/frontend/`

  * `index.html`, `dashboard.js`, `market.js`, `portfolio.js`, `admin.js`, `style.css`
* `/backend/`

  * Routes: `admin.js`, `market.js`
  * Integrates Finnhub + Yahoo APIs
* Wallet connect (manual then Coinbase SDK)
* Live charts, holders, and profile sections

## Features

* Auto-airdrop 1M TGBP on first wallet connect
* Partial order fills and live order book
* PriceFeed-driven chart with weekday labels
* Summary / Holders / Profile tabs

## Tests

* Manual testing per function
* Wallet connection and transaction flow validated

## Approval Criteria

* UI matches specification image
* All functions operational on local Hardhat network
