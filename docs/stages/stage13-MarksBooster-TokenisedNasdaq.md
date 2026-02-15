# Stage 13 — Auto Trade with On-Chain Order Book Triggers

## 13.0 Purpose

Replace call-auction and basket work with an automated trading stage.

This stage introduces:

- auto buy rules
- auto sell rules
- on-chain order book watcher loop
- execution against existing order-book paths

Basket ETF and call auction are removed from Stage 13 scope.

---

## 13.1 In-Scope Features

## 13.1.1 Auto trade rule model

Support per-wallet rules:

- `AUTO_BUY`
- `AUTO_SELL`

Required rule fields:

- `wallet`
- `symbol`
- `side` (`BUY` or `SELL`)
- `triggerPriceCents`
- `qtyWei`
- `maxSlippageBps`
- `enabled`

Optional controls:

- cooldown seconds
- max executions per day

## 13.1.2 On-chain order book watcher (3-second cadence)

Backend loop must:

- read best bid and best ask from the on-chain order book every 3 seconds
- evaluate enabled auto rules after each polling tick

Trigger rule:

- `AUTO_BUY` triggers when best ask is less than or equal to rule trigger price
- `AUTO_SELL` triggers when best bid is greater than or equal to rule trigger price

Execution rule:

- if trigger condition is met, place trade using existing on-chain execution path
- log rule execution with tx hash

## 13.1.3 Symbol lifecycle controls (kept)

Keep symbol lifecycle from current plan:

- `ACTIVE`
- `FROZEN`
- `DELISTED`

Rule engine must respect status:

- no new auto executions for frozen/delisted symbols
- existing rules remain stored but paused while not tradable

User-facing lifecycle behavior:

- `ACTIVE`
  - symbol is visible on Markets
  - symbol is tradable (manual and auto)
- `FROZEN`
  - symbol remains visible on Markets
  - symbol is not tradable (manual and auto blocked)
- `DELISTED`
  - symbol is removed from Markets display/selectors
  - symbol is not tradable (manual and auto blocked)

Portfolio behavior for all states:

- existing equity holdings remain visible in Portfolio
- holdings are not removed by freeze/delist state changes

---

## 13.2 API Additions

## 13.2.1 Rule management

- `POST /api/autotrade/rules/create`
- `POST /api/autotrade/rules/update`
- `POST /api/autotrade/rules/enable`
- `POST /api/autotrade/rules/disable`
- `POST /api/autotrade/rules/delete`
- `GET /api/autotrade/rules?wallet=0x...`

## 13.2.2 Execution and monitoring

- `GET /api/autotrade/status`
- `POST /api/autotrade/listener/start`
- `POST /api/autotrade/listener/stop`
- `GET /api/autotrade/executions?wallet=0x...`

## 13.2.3 Symbol lifecycle (kept)

- `POST /api/admin/symbols/list`
- `POST /api/admin/symbols/freeze`
- `POST /api/admin/symbols/unfreeze`
- `POST /api/admin/symbols/delist`
- `GET /api/admin/symbols/status`

---

## 13.3 Contract/Backend Notes

Contract:

- keep `ListingsRegistry` tradability state enforcement in `OrderBookDEX`
- reuse current buy/sell execution paths

Backend:

- implement deterministic 3-second listener loop
- avoid duplicate triggers in same tick
- use on-chain order book prices only for trigger checks
- persist rule and execution logs to local storage file

---

## 13.4 UI Additions

## 13.4.1 Admin page (`admin.html`)

Add panels:

- symbol lifecycle controls (freeze/unfreeze/delist)
- listener status and start/stop control

## 13.4.2 Trade page (`trade.html` / `sell.html`)

Add panels:

- create auto buy rule
- create auto sell rule
- list and toggle own rules

## 13.4.3 Portfolio and Transactions pages

Add behavior:

- show auto execution history in transactions feed
- show rule-driven executions with clear labels

---

## 13.5 Acceptance Criteria

1. User creates auto buy rule and it executes automatically when on-chain best ask satisfies the trigger.
2. User creates auto sell rule and it executes automatically when on-chain best bid satisfies the trigger.
3. Order book watcher runs every 3 seconds while running.
4. Frozen/delisted symbols do not execute auto trades.
5. Execution log shows trigger price, executed tx hash, and timestamp.

---

## 13.6 Evidence Package for Report

Capture:

1. auto buy rule creation and triggered execution
2. auto sell rule creation and triggered execution
3. order book watcher tick evidence at 3-second cadence
4. freeze/delist pause behavior for auto rules

---

## 13.7 Out of Scope

- basket ETF
- call auction
- execution-quality metrics module
- session-aware market mode module
- stock split corporate action

---

## 13.8 Award Link

Award upgrade planning is moved to:

- `docs/stages/stage13.5-Award-Plan.md`
