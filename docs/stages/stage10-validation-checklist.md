# Stage 10 Validation Checklist (Indexer + Transactions + Cancel)

This checklist validates:

1. off-chain index completeness (orders/fills/cancels/cashflows/transfers)
2. cursor pagination behavior in transactions page/API
3. restart and idempotency behavior

---

## 1) Start services

Terminal A:

```bash
cd /Users/tigerfang/Desktop/tokenised-lse
npm run dev:chain
```

Terminal B:

```bash
cd /Users/tigerfang/Desktop/tokenised-lse/scripts/ui
npm run dev
```

---

## 2) Indexer baseline status

```bash
curl "http://localhost:3000/api/indexer/status"
```

Record:

- `state.lastIndexedBlock`
- `totals`
- `checksum`

---

## 3) Generate sample activity

Use two wallets from Hardhat unlocked accounts.

1. mint TToken to buyer
2. create/mint equity to seller
3. place sell order
4. place buy order
5. cancel one remaining open order

Example endpoints:

- `POST /api/ttoken/mint`
- `POST /api/equity/create-mint`
- `POST /api/orderbook/limit`
- `POST /api/orders/cancel`

---

## 4) Verify indexed artifacts on disk

```bash
ls -la cache/indexer
cat cache/indexer/state.json
cat cache/indexer/orders.json
cat cache/indexer/fills.json
cat cache/indexer/cancellations.json
cat cache/indexer/cashflows.json
cat cache/indexer/transfers.json
```

Expected:

- files exist and are valid JSON
- `state.lastIndexedBlock` moves forward
- `transfers.json` contains ERC20 `Transfer` events for tracked tokens

---

## 5) Wallet-scoped API checks

Orders:

```bash
curl "http://localhost:3000/api/orders/open?wallet=<WALLET>"
```

Transactions all:

```bash
curl "http://localhost:3000/api/txs?wallet=<WALLET>&type=ALL&limit=50"
```

Transfers only:

```bash
curl "http://localhost:3000/api/txs?wallet=<WALLET>&type=TRANSFERS&limit=50"
```

Expected:

- only selected wallet records are returned
- tx rows include order/fill/cashflow/transfer kinds where applicable

---

## 6) Cursor pagination checks

1. Call first page:

```bash
curl "http://localhost:3000/api/txs?wallet=<WALLET>&type=ALL&limit=5"
```

2. Copy `nextCursor` and call second page:

```bash
curl "http://localhost:3000/api/txs?wallet=<WALLET>&type=ALL&limit=5&cursor=<NEXT_CURSOR>"
```

Expected:

- second page has different items (no duplicate first-page entries)
- `nextCursor` eventually becomes `null`

Frontend pagination:

- open Transactions page
- click `Load more` until disabled
- confirm item count increases and button changes to `No more items`

---

## 7) Restart + idempotency checks

1. Capture status before restart:

```bash
curl "http://localhost:3000/api/indexer/status"
```

2. Stop backend (Terminal B), restart backend:

```bash
cd /Users/tigerfang/Desktop/tokenised-lse/scripts/ui
npm run dev
```

3. Capture status after restart:

```bash
curl "http://localhost:3000/api/indexer/status"
```

Expected:

- `checksum` remains unchanged if no new chain activity
- counts do not duplicate
- `lastIndexedBlock` remains stable or advances only if new blocks/events exist

4. Optional idempotency stress:
- restart backend twice more without new txs
- verify same checksum each time

---

## 8) UI behavior checks

Transactions page:

- wallet shown in full (no ellipsis)
- tx hash shown in full (no ellipsis)
- amounts shown in token units (not raw 18-decimal wei)
- `Action` shows:
  - `Cancel` for open/partial order rows
  - `Completed` for non-cancellable rows

---

## 9) Pass criteria

Stage 10 can be considered complete when all checks above pass:

1. indexer produces consistent local state
2. wallet-scoped queries are correct
3. cancel flow works end-to-end
4. pagination works in API and UI
5. restart/idempotency behavior is stable

