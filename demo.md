# Demo Plan

This document is a complete demonstration plan with scripts, technical context, and theoretical knowledge needed to explain the system clearly.

## 1) Demonstration Structure

### 1.1 Goal
Demonstrate progress toward deliverables, show planning, demonstrate problem solving, and explain the system clearly with evidence.

### 1.2 Duration and sections
- Section A: Environment and deployment evidence
- Section B: Token minting and registry
- Section C: Market data integration
- Section D: Trading workflow
- Section E: Admin and on chain verification
- Section F: Summary and missing components

## 2) Theoretical Knowledge You Should State

### 2.1 Token standards and decimals
- TToken and EquityToken are ERC20 style tokens.
- Token balances are stored with 18 decimals, so on chain values are in wei like units.
- Example: 1000 tokens is `1000 * 10^18` on chain.

### 2.2 On chain vs off chain roles
- On chain: token issuance, order book state, and trades are stored and validated by contracts.
- Off chain: price feeds and UI data are derived from external APIs and displayed via the backend.

### 2.3 Order book model
- Orders are stored on chain as arrays per symbol.
- Buy orders escrow TToken, sell orders escrow the equity token.
- Matching is done inside the OrderBookDEX contract.
- Fills emit events and are later read by the admin UI through log scans.

### 2.4 Price feed model
- PriceFeed stores a price and timestamp per symbol.
- It supports freshness checks to prevent stale pricing in oracle based orders.
- Market data in the UI comes from FMP and Yahoo and is not written on chain yet.

### 2.5 Registry and factory
- ListingsRegistry stores symbol to token address mappings.
- EquityTokenFactory creates an EquityToken and registers it in the registry.

### 2.6 Dividends
- Dividends contract exists but is not wired to UI or API.
- No dividend claim flow is demonstrated yet.

### 2.7 Security and roles
- Admin addresses are used to deploy and mint.
- There is no backend authentication layer in the current build.

## 3) Scripted Demo Flow

### 3.1 Pre demo setup
Terminal commands to start the chain and deploy:
```
cd /Users/tigerfang/Desktop/tokenised-lse
npm run dev:chain
```

Expected outputs:
- TToken deployed address
- ListingsRegistry, EquityTokenFactory, PriceFeed addresses
- OrderBookDEX address
- Dividends address
- Deployments file updated at `deployments/localhost.json`

### 3.2 UI launch
Start the UI server:
```
cd /Users/tigerfang/Desktop/tokenised-lse/scripts/ui
npm run dev
```

Open in browser:
```
http://localhost:3000
```

### 3.3 MetaMask setup
- Network:
  - RPC: `http://127.0.0.1:8545`
  - Chain ID: `31337`
  - Symbol: `ETH`
- Import test account with Hardhat private key.

### 3.4 Demonstrate TToken mint
- Open TToken page.
- Enter amount 1000 and click Airdrop.
- Show transaction hash returned by API.
- Import the TToken address from `deployments/localhost.json` in MetaMask.
- Show balance increase.

### 3.5 Demonstrate equity token mint
- In TToken page, select AAPL and click Mint Equity.
- If token does not exist, it is created and minted in one step.
- Import the equity token address and show balance.

### 3.6 Demonstrate market data
- Open Markets page.
- Load candles for TSLA.
- Show live price and stock info box.
- Toggle live updates on and off.

### 3.7 Demonstrate buy order
- Go to Trade page.
- Select AAPL, set price, qty, click Buy.
- Show status message with tx hash.

### 3.8 Demonstrate sell order
- Go to Portfolio page and click AAPL row.
- On Sell page, click Sell.
- Show status message with tx hash.

### 3.9 Demonstrate admin order book
- Open Admin page.
- Show open orders table.
- Show completed transactions table.
- Explain that completed orders come from `OrderFilled` logs.

### 3.10 End summary
- Show progress and identify missing pieces:
  - Cost basis and PnL are placeholders.
  - Auto buy and auto sell are UI only.
  - Dividends not wired.
  - No indexer or database.

## 4) REST API Quick Reference for Demo

### 4.1 TToken mint
```
POST /api/ttoken/mint
{
  "to": "0xWALLET",
  "amount": 1000
}
```

### 4.2 Equity create and mint
```
POST /api/equity/create-mint
{
  "symbol": "AAPL",
  "name": "Apple",
  "to": "0xWALLET",
  "amount": 1000
}
```

### 4.3 Place limit order
```
POST /api/orderbook/limit
{
  "symbol": "AAPL",
  "side": "BUY",
  "priceCents": 39500,
  "qty": 1000,
  "from": "0xWALLET"
}
```

### 4.4 Read open orders
```
GET /api/orderbook/open
```

### 4.5 Read fills
```
GET /api/orderbook/fills
```

## 5) Demo Checklist

- Chain running
- Deployments updated
- MetaMask connected to local chain
- TToken minted and visible
- Equity minted and visible
- Live price and candle chart shown
- Buy and sell orders placed
- Admin open and completed tables populated

