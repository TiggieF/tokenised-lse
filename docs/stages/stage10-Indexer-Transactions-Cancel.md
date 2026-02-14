# Stage 10 — Off-Chain Indexer, User Transactions, and Order Cancellation

## 10.0 Purpose

This stage upgrades the system from "read direct from contracts" to "index, query, and reconstruct state" for:

- user-scoped transaction history
- order lifecycle tracking
- cancellation from UI
- portfolio accounting input (fills and cashflow)

This stage is foundational for Stage 11 portfolio economics.

---

## 10.1 Deliverables

1. Event indexer service with:
- historical backfill from deployment block
- live event subscription/tailing
- idempotent writes and restart safety

2. Indexed entities:
- order placed
- order filled
- order cancelled
- leveraged product lifecycle placeholders (for Stage 12 compatibility)
- token transfer ledger entries for TToken and equity tokens

3. Transaction APIs:
- wallet-only transaction feed
- open orders by wallet
- cancel order endpoint
- order details endpoint

4. Frontend page:
- `transactions.html` (wallet-specific)
- tabs: Orders, Fills, Cashflow
- "Cancel" action for cancellable open orders only

---

## 10.2 Architecture

## 10.2.1 Process model

- Process A: `indexer-backfill`
  - runs once on startup
  - catches up from `fromBlock` to `latest`

- Process B: `indexer-live`
  - subscribes/polls new blocks
  - ingests fresh logs continuously

- Process C: API server
  - serves query endpoints from indexed store
  - never recomputes chain state in request path

## 10.2.2 Storage choice

Use JSON files as the primary storage model for portability to hosted environments.

Recommended structure:

- `data/indexer/orders.jsonl`
- `data/indexer/fills.jsonl`
- `data/indexer/cancellations.jsonl`
- `data/indexer/cashflows.jsonl`
- `data/indexer/snapshots/*.json`

Implementation note:

- ingest to append-only JSONL logs
- periodically materialize read models into snapshot JSON files for fast API reads

---

## 10.3 Data Model

## 10.3.1 Core tables

`indexed_blocks`
- `number` (PK)
- `hash`
- `parent_hash`
- `timestamp`
- `indexed_at`

`orders`
- `order_id` (PK)
- `symbol`
- `equity_token`
- `side` (`BUY`/`SELL`)
- `price_cents`
- `qty_wei`
- `remaining_wei`
- `trader`
- `status` (`OPEN`/`PARTIAL`/`FILLED`/`CANCELLED`)
- `placed_tx_hash`
- `placed_block`
- `created_at`
- `updated_at`

`fills`
- `id` (PK, autoincrement)
- `maker_order_id`
- `taker_order_id`
- `symbol`
- `price_cents`
- `qty_wei`
- `maker_trader`
- `taker_trader`
- `tx_hash`
- `block_number`
- `log_index`
- `timestamp`
- unique key (`tx_hash`, `log_index`)

`order_cancellations`
- `id` (PK)
- `order_id`
- `trader`
- `tx_hash`
- `block_number`
- `timestamp`
- unique key (`tx_hash`, `order_id`)

`wallet_cashflows`
- `id` (PK)
- `wallet`
- `asset_type` (`TTOKEN`/`EQUITY`/`LEVERAGED`)
- `asset_symbol`
- `direction` (`IN`/`OUT`)
- `amount_wei`
- `reason` (`TRADE_BUY`,`TRADE_SELL`,`DIVIDEND`,`AIRDROP`,`LEVERAGE_MINT`,`LEVERAGE_UNWIND`)
- `tx_hash`
- `block_number`
- `timestamp`

`sync_state`
- `key` (PK)
- `value`

## 10.3.2 Indexes

- `orders(trader, status, updated_at desc)`
- `fills(maker_trader, timestamp desc)`
- `fills(taker_trader, timestamp desc)`
- `wallet_cashflows(wallet, timestamp desc)`

---

## 10.4 Ingestion Spec

## 10.4.1 Contracts/events to ingest

Mandatory in Stage 10:

- `OrderBookDEX.OrderPlaced`
- `OrderBookDEX.OrderFilled`
- `OrderBookDEX.OrderCancelled` (add if missing)
- `ERC20.Transfer` on TToken and known equity tokens

Optional now, required later:

- `Dividends` claim/declaration events
- `Award` epoch finalization events

## 10.4.2 Idempotency rules

- Every write keyed by (`tx_hash`,`log_index`) where available.
- Re-processing a block must be no-op.
- On restart, resume from `last_indexed_block + 1`.

## 10.4.3 Reorg policy (local chain safe mode)

- Keep `REORG_DEPTH = 0` for Hardhat local.
- For future extension set depth 6 and rollback window.

---

## 10.5 API Contract

All wallet-scoped endpoints must use `wallet` query or path parameter and return only that wallet's data.

## 10.5.1 List wallet transactions

`GET /api/txs?wallet=0x...&cursor=...&limit=50&type=ALL|ORDERS|FILLS|CASHFLOW`

Response:

```json
{
  "items": [
    {
      "kind": "ORDER_PLACED",
      "wallet": "0x...",
      "symbol": "AAPL",
      "side": "BUY",
      "priceCents": 19500,
      "qtyWei": "1000000000000000000",
      "timestamp": 1700000000,
      "txHash": "0x..."
    }
  ],
  "nextCursor": "..."
}
```

## 10.5.2 List open orders by wallet

`GET /api/orders/open?wallet=0x...`

Response includes `cancellable: true|false`.

## 10.5.3 Cancel order

`POST /api/orders/cancel`

Body:

```json
{
  "wallet": "0x...",
  "orderId": 123
}
```

Behavior:

- Verify `order.trader == wallet`.
- Call `OrderBookDEX.cancelOrder(orderId)`.
- Return tx hash and optimistic status.

## 10.5.4 Order details

`GET /api/orders/:orderId?wallet=0x...`

- Return 404 if order not owned by wallet.

---

## 10.6 Frontend — `transactions.html`

## 10.6.1 UI requirements

- Connected wallet header and sync status badge.
- Filter chips:
  - `All`
  - `Orders`
  - `Fills`
  - `Cashflow`
- Date range filter (`7d`, `30d`, `All`).
- Search by symbol.

## 10.6.2 Orders tab

Columns:

- Time
- Symbol
- Side
- Limit Price
- Original Qty
- Remaining
- Status
- Action

Action rules:

- Show `Cancel` only for `OPEN` or `PARTIAL`.
- Hide cancel for non-owned orders by design (should never appear).

## 10.6.3 Fills tab

Columns:

- Time
- Symbol
- Side (derived by wallet role)
- Price
- Qty
- Notional
- Tx hash short link

## 10.6.4 Cashflow tab

Columns:

- Time
- Asset
- Direction
- Amount
- Reason
- Tx hash

---

## 10.7 Backend Implementation Checklist

1. Add `scripts/indexer/config.js`:
- RPC URL
- deployment block
- polling interval
- db path

2. Add `scripts/indexer/start.js`:
- bootstrap DB
- backfill
- live tail

3. Add `scripts/indexer/handlers/*.js`:
- per-event decoder and upsert

4. Extend `scripts/ui/html/server.js`:
- tx endpoints
- open orders endpoint
- cancel endpoint

5. Add nav link to transactions page in shell.

---

## 10.8 Acceptance Tests

1. Place 3 orders from Wallet A, 2 from Wallet B.
2. Open Transactions as Wallet A.
3. Verify only Wallet A orders appear.
4. Cancel one open order in page.
5. Confirm:
- tx succeeds
- order status changes to `CANCELLED`
- Wallet B page unaffected
6. Restart indexer and confirm data is stable (idempotent).

---

## 10.9 Out of Scope

- authentication layer
- admin security hardening
- advanced reorg recovery

These are intentionally deferred in this roadmap.
