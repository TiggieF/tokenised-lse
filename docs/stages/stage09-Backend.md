# Stage 9 — Backend Services (Oracle + Auto‑Trade + Rewards)

This stage defines the backend services required to automate:
- oracle price updates
- award finalization
- auto‑buy / auto‑sell at target prices

---

## 9.0 Objectives

1) Keep **PriceFeed** updated with live prices.  
2) Trigger **Award.finalizeEpoch** every 90 seconds.  
3) Execute **auto‑trade rules** (buy/sell when price crosses a target).

---

## 9.1 Components

### 9.1.1 Oracle Updater
- Fetch prices from Finnhub (or Yahoo).
- Call `PriceFeed.setPrice(symbol, priceCents)`.
- Must use wallet with `ORACLE_ROLE`.

### 9.1.2 Award Finalizer
- Every 90 seconds:
  - `finalizeEpoch(currentEpoch - 1)`
- Must use wallet with permission to call finalize (permissionless in current design).

### 9.1.3 Auto‑Trade Engine
Allows users to set rules like:
```
BUY 1 TToken worth of AAPL when price <= 250.00
SELL 0.5 AAPL when price >= 300.00
```

Backend responsibilities:
- Store user rules (off‑chain DB)
- Watch PriceFeed + OrderBook
- When trigger condition is met, send transaction:
  - `buyExactQuoteAtOracle` (for auto‑buy)
  - `placeLimitOrder` (for auto‑sell)

**Important:** auto‑trades are **user‑authorized**:
- Option A: store user private key (not recommended)
- Option B: user signs a permissioned meta‑transaction
- Option C: user pre‑approves backend wallet as a trusted operator (recommended for demo)

---

## 9.2 API Endpoints (suggested)

### Auto‑trade
```
POST /autotrade
GET  /autotrade/:wallet
DELETE /autotrade/:id
```

Payload example:
```json
{
  "wallet": "0x...",
  "symbol": "AAPL",
  "side": "BUY",
  "quoteWei": "1000000000000000000",
  "priceCents": 25000,
  "slippageBps": 100
}
```

### Admin/Oracle
```
POST /oracle/update
POST /award/finalize
```

---

## 9.3 Data storage

Minimal DB:
- Users
- Auto‑trade rules
- Rule status (active, triggered, cancelled)

---

## 9.4 Security considerations

- Never store raw private keys in production.
- Use environment‑protected admin keys.
- Rate‑limit auto‑trade submissions.
- Ensure one rule triggers only once (idempotent).

---

## 9.5 Approval Criteria

- PriceFeed updates automatically
- Award finalize runs on schedule
- Auto‑trade rules trigger reliably
- Backend services log all actions for audit
