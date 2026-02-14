# Stage 11 — Portfolio Economics, Dividends, Award, and Aggregator Wiring

## 11.0 Purpose

Stage 11 converts portfolio view from balance-only to full accounting:

- transaction-rebuilt cost basis
- realized and unrealized PnL
- current market valuation
- dividend flows
- award flows
- on-chain aggregator integration

This stage depends on Stage 10 indexed fills and cashflows.

---

## 11.1 Deliverables

1. Portfolio accounting engine (backend service module).
2. New portfolio APIs for summary and positions.
3. Dividends endpoints and frontend claim/admin flows.
4. Award endpoints and frontend tracking page.
5. PortfolioAggregator wiring for cross-check and quick reads.

---

## 11.2 Portfolio Accounting Model

## 11.2.1 Position ledger inputs

Use indexed events only:

- fills (buy/sell)
- token airdrops
- dividends received
- leveraged lifecycle placeholder entries (future stage)

## 11.2.2 Cost basis method

Use one clear method and document it in UI.

Recommended for grading clarity: `FIFO`.

For each symbol:

- Buy fill adds inventory lot:
  - `qty`
  - `unit_cost`
  - `fee` (currently zero)
- Sell fill consumes lots in FIFO order.
- Realized PnL accumulates on consumed qty.

## 11.2.3 Metrics per symbol

- `quantity`
- `avg_cost`
- `cost_basis_total`
- `market_price`
- `market_value`
- `unrealized_pnl`
- `realized_pnl`
- `total_pnl`
- `dividends_received`
- `net_return_pct`

## 11.2.4 Portfolio totals

- `cash_value_ttoken`
- `equity_market_value`
- `leveraged_market_value` (0 in this stage unless Stage 12 active)
- `total_value`
- `total_cost_basis`
- `total_realized_pnl`
- `total_unrealized_pnl`
- `total_return_pct`

---

## 11.3 Price Path for Current Valuation

Priority:

1. Live quote endpoint (`/api/fmp/quote-short`).
2. PriceFeed on-chain latest (if quote fetch fails).
3. Last indexed fill price (if both unavailable).

Return source label with each price:

- `LIVE`
- `ONCHAIN_PRICEFEED`
- `LAST_FILL`

---

## 11.4 API Specification

## 11.4.1 Portfolio summary

`GET /api/portfolio/summary?wallet=0x...`

Response:

```json
{
  "wallet": "0x...",
  "cashValueWei": "0",
  "stockValueWei": "0",
  "leveragedValueWei": "0",
  "totalValueWei": "0",
  "totalCostBasisWei": "0",
  "realizedPnlWei": "0",
  "unrealizedPnlWei": "0",
  "dividendsReceivedWei": "0",
  "awardsReceivedWei": "0"
}
```

## 11.4.2 Portfolio positions

`GET /api/portfolio/positions?wallet=0x...`

Each item includes:

- symbol
- quantityWei
- avgCostCents
- costBasisWei
- currentPriceCents
- currentValueWei
- realizedPnlWei
- unrealizedPnlWei
- lastUpdated

## 11.4.3 Transaction rebuild audit

`GET /api/portfolio/rebuild-audit?wallet=0x...`

Include:

- processed fill count
- lot states
- last processed block
- checksum hash of rebuild state

## 11.4.4 Dividends endpoints

- `GET /api/dividends/epochs?symbol=AAPL`
- `GET /api/dividends/claimable?wallet=0x...&symbol=AAPL&epochId=1`
- `POST /api/dividends/claim`
- `POST /api/dividends/declare` (admin page action; no auth hardening in this stage)

## 11.4.5 Award endpoints

- `GET /api/award/current`
- `GET /api/award/history?limit=50`
- `POST /api/award/finalize` (manual trigger for demo)

---

## 11.5 Frontend Requirements

## 11.5.1 Portfolio page upgrades

Add columns:

- Cost basis
- Avg cost
- Current price
- Realized PnL
- Unrealized PnL
- Total return %
- Price source

Add cards:

- Cash
- Equities
- Leveraged
- Dividends earned
- Awards earned

## 11.5.2 Dividends page

User panel:

- symbol selector
- epoch list
- claimable preview
- claim button

Admin panel:

- symbol
- dividend per share
- declare action

## 11.5.3 Award page

- current epoch
- current leader
- historical winners table
- manual finalize button for demo

---

## 11.6 PortfolioAggregator Wiring

Use `PortfolioAggregator` as:

- primary fast path for holdings/summary
- secondary validation against indexed rebuild

If drift detected:

- show warning badge in portfolio page
- expose drift details in `rebuild-audit` endpoint

---

## 11.7 Backend Implementation Checklist

1. Add `services/portfolio-rebuild.js`.
2. Add `services/valuation.js`.
3. Add dividends route handlers.
4. Add award route handlers.
5. Add aggregator read route handlers.
6. Update portfolio frontend script and tables.

---

## 11.8 Acceptance Criteria

1. User executes buy/sell sequence with partial fills.
2. Portfolio summary reflects:
- correct quantity
- FIFO-based cost basis
- realized and unrealized PnL
3. Dividend declare then claim updates cashflow and portfolio totals.
4. Award finalize updates award history and cashflow.
5. Aggregator and rebuild values stay within expected tolerance (exact match for local chain).

---

## 11.9 Out of Scope

- maker/taker fee model
- financing rates for leverage
- security/admin hardening

Those are intentionally postponed.

