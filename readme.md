# Tokenised LSE DEX

## Overview
A blockchain prototype that tokenises UK-listed equities and enables on-chain trading using TGBP, a capped stable token.  
Built on EVM (Hardhat local → Sepolia testnet), with full on-chain accounting, rewards, and dividends.

---

## Features
- **On-chain order book** – Limit orders, partial fills, price-time priority.  
- **Stable token (TGBP)** – Capped supply; airdrop 1 M TGBP per wallet.  
- **Rewards** – Top trader per 3-minute epoch earns 3 TGBP.  
- **Dividends** – Admin-declared payouts in TGBP.  
- **Analytics** – Portfolio composition, Fresh/Stale prices, charts.  
- **Wallets** – Coinbase / MetaMask integration for trading.  

---

## Quick Start
```bash
conda create -n tokenised-lse python=3.10 nodejs=18
conda activate tokenised-lse
npm install
cp .env.example .env
npx hardhat node
npx hardhat run scripts/deploy_all.js --network localhost
cd backend && node server.js
cd frontend && npm run dev
