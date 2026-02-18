# Tokenised LSE DEX — Product Requirements Document (PRD)

## 1. Vision  
Create a decentralised, on-chain trading prototype for UK-listed equities, built on an EVM-compatible blockchain.  
Each listed company is represented by its own ERC-20 “EquityToken”.  
Users trade these tokens using the stable currency “TToken”.  
Full orderbook, trades, balances, rewards, dividends, listings—all visible on‐chain.  
The UI presents both trading and analytics (portfolio breakdown, holder data, company profile).  
This is a **research prototype**, not a live brokerage.

## 2. Purpose & Problem Statement  
- Problem: Traditional equity trading lacks full transparency and on-chain provenance.  
- Purpose: Provide a transparent, experiment-grade system where every trade, balance, reward is recorded on-chain.  
- Who: Traders (wallet-users), Admin (issuer/listing manager), Observers (security/research reviewers).

## 3. Target Users & Personas  
- **Admin**: Lists companies, mints stock tokens, sets prices, declares dividends, funds reward pool.  
- **Trader**: Connects wallet (non-custodial), receives initial TToken airdrop, places limit orders, competes for rewards, claims dividends.  
- **Observer / Marker**: Examines on-chain transparency, solidity design, UI clarity and analytics features.

## 4. Key Features  
- TToken token: capped supply (3×10^50 units), 18 decimals, airdrop of 1,000,000 to each user wallet once.  
- EquityTokenFactory: Deploys per-company ERC-20 tokens.  
- ListingsRegistry: Maintains list of symbols → token addresses.  
- PriceFeed: Admin-only single source sets price in pence and timestamp; UI shows “Fresh” or “Stale”.  
- OrderBookDEX: Limit orders only (no IOC), partial fills allowed, taker pays 0.0001% fee (1 ppm).  
- FeePool: Tracks trading volume every 3-minute epoch; top trader earns 3 TToken.  
- Dividends: Admin declares payout in TToken; token holders claim proportionally via snapshot.  
- Portfolio Aggregator & UI: Portfolio value, composition, charts, holders’ breakdown, company profile.

## 5. Frozen Rules (Core Constraints)  
- Order type: Limit only. Partial fills allowed. Immediate or Cancel (IOC) orders **not** allowed.  
- Protocol fee fixed at 0.0001% (1 part per million), adjustable only by admin role.  
- Reward: 3 TToken per epoch (3 minutes) earned by highest-volume trader; if no trades, no reward.  
- Airdrop: One-time only; each wallet receives 1,000,000 TToken on first connect.  
- Max supply of TToken: 3 × 10^50 units (18 decimals).  
- On-chain canonical truth for: trading ledger, token balances, orderbook state, rewards, dividends, listings.  
- Oracle: Admin (or script) updates price on-chain; no off-chain matching or Merkle proofs in MVP.  
- Market hours indicator (Fresh/Stale) shown in UI (08:00–16:30 Europe/London), but trading always possible on-chain.

## 6. Success Metrics  
- Successful deployment of all core contracts on local Hardhat node.  
- UI shows correct values, portfolio updates live, holder breakdown and company profile loads as expected.  
- Tests cover > 90% lines in Solidity; orderbook matching, partial fills and fee logic verified.  
- Admin functions (list, price update, dividend) operate correctly.  
- No off-chain hidden logic — total supply, trades, balances all auditable.

## 7. Scope & Out-of-Scope  
**In Scope:**  
- Implementation of listed features for MVP.  
- Support for UK-listed equities only (top companies).  
- Desktop browser UI; mobile adaptation optional.  
**Out of Scope (for MVP):**  
- Live production deployment, regulatory compliance, KYC.  
- High performance production matching engine (million orders/sec).  
- Fiat ramps, user wallets management, multi-chain expansions.

## 8. Timeline & Approval  
Work will proceed in **stages** (see `docs/stages/stage-plan.md`).  
Each stage must pass its acceptance criteria and gain admin approval **before** moving to the next.

## 9. Barrier to Codex  
**DO NOT implement any functionality beyond Stage 1 → 8 as defined.**  
Codex must *not* jump ahead, add features or change architecture without explicit approval.  
All changes must be gated by individual stage docs and admin review.

