# Stage 13 — Tokenised NASDAQ Realism (Scoped Version)

## 13.0 Purpose

Add high-impact realism features aligned to your chosen scope:

- no execution-metrics module in this stage
- no session-state market-mode module
- no stock split implementation
- keep delist/freeze
- keep lightweight call-auction feature

---

## 13.1 In-Scope Features

## 13.1.1 Admin-managed NASDAQ symbol onboarding (local list)

From `admin.html`, provide:

- symbol picker from local source file in repository
- company name auto-fill from local list
- one-click listing creation via `EquityTokenFactory`

Requirements:

- source file versioned in repo (no runtime third-party dependency)
- symbol can be enabled/disabled for trading in admin UI
- newly listed symbol appears in chart/trade/portfolio flows

## 13.1.2 Delist/Freeze flow (no stock split)

Implement delist/freeze semantics:

- `ACTIVE`: normal trading
- `FROZEN`: cannot place new orders, existing open orders cancellable only
- `DELISTED`: no new orders, no matching, symbol removed from trading selectors

User-facing behavior:

- users still see holdings in portfolio
- users cannot trade frozen/delisted symbols against TToken
- transactions page records freeze/delist events affecting held symbols

## 13.1.3 Lightweight call-auction mode (item 5 clarified)

Definition of item 5:

- a short batching mode where orders are collected first
- one crossing price is computed
- matched quantity executes in one batch
- then order book returns to normal continuous mode

Project implementation scope:

- manual trigger from admin page per symbol
- configurable auction window (e.g., 30 to 120 seconds)
- deterministic crossing price algorithm (maximize matched quantity, then tie-break by closest to last price)

Why this helps marks:

- demonstrates non-trivial market microstructure beyond plain limit-order matching.

---

## 13.2 API Additions

## 13.2.1 Local NASDAQ catalog

- `GET /api/admin/nasdaq-symbols`
  - reads from local file (example: `scripts/ui/data/symbols/nasdaq.json`)

## 13.2.2 Symbol lifecycle

- `POST /api/admin/symbols/list`
- `POST /api/admin/symbols/freeze`
- `POST /api/admin/symbols/unfreeze`
- `POST /api/admin/symbols/delist`
- `GET /api/admin/symbols/status`

## 13.2.3 Call auction

- `POST /api/admin/auction/start`
- `GET /api/admin/auction/status?symbol=TSLA`
- `POST /api/admin/auction/execute`

---

## 13.3 Contract/Backend Notes

Contract-side options:

1. Preferred: add symbol tradability state in `ListingsRegistry` and enforce checks in `OrderBookDEX`.
2. Alternative: enforce state only at backend order entry path (weaker for decentralised correctness).

Recommendation:

- enforce in contract for grading strength and correctness.

---

## 13.4 UI Additions

## 13.4.1 Admin page (`admin.html`)

Add panels:

- NASDAQ local symbol onboarding
- symbol status controls (freeze/unfreeze/delist)
- auction control panel

## 13.4.2 Trade page (`trade.html` / `sell.html`)

Add behavior:

- symbol status badge
- disable action buttons when symbol not tradable
- show clear reason text (`FROZEN` or `DELISTED`)

## 13.4.3 Portfolio and Transactions pages

Add behavior:

- show delisted/frozen badge beside holdings
- show lifecycle events in transaction feed

---

## 13.5 Acceptance Criteria

1. Admin lists a NASDAQ symbol from local file and it is tradable end-to-end.
2. Admin freezes symbol; users cannot place new orders but can cancel existing open orders.
3. Admin delists symbol; users cannot trade it against TToken and UI reflects status.
4. Admin runs call auction on an active symbol and batch execution occurs at deterministic crossing price.

---

## 13.6 Evidence Package for Report

Capture:

1. symbol onboarding from local list
2. freeze/delist lifecycle behavior in UI
3. auction run with before/after order book snapshots
4. resulting user transaction records

---

## 13.7 Out of Scope

- execution-quality metrics module
- session-aware market mode module
- stock split corporate action

