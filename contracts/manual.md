# Tokenised LSE Manual

This manual documents the system as implemented. It is a precise handover intended for a developer who will continue the project.

## 1) System Summary

The system is a local Hardhat blockchain with a Node and Express API server and a multi page HTML frontend. The smart contracts implement a listings registry, equity tokens, a stable settlement token, and an on chain order book. The frontend uses the backend to read and write on chain data and to pull off chain market data.

## 2) Architecture

### 2.1 On chain components
- TToken: stable settlement token used for buys.
- ListingsRegistry: registry from symbol to token address.
- EquityTokenFactory: creates new equity tokens and registers them.
- EquityToken: ERC20 equity token for each listed symbol.
- PriceFeed: simple on chain price storage for a symbol.
- OrderBookDEX: on chain order book with escrow and limit orders.
- Dividends: dividend accounting contract, deployed but not wired to UI or API.
- Award: trade reward tracking, deployed but not wired to UI or API.
- PortfolioAggregator: portfolio summary helper, deployed but not wired to UI or API.

### 2.2 Off chain components
- Express server at `scripts/ui/html/server.js`.
- Market data aggregation with FMP as primary and Yahoo as fallback.
- UI pages under `scripts/ui/html/public/` and markets chart under `scripts/ui/dataFetch/tsla-yahoo/chart.html`.

### 2.3 Data flow
- UI uses backend REST API for on chain reads and writes and for market data.
- Backend uses Hardhat JSON RPC to call and send transactions to contracts.
- Admin UI reads on chain order book and fills using RPC log scans.

## 3) Frontend Modules

### 3.1 Shell
**File**: `scripts/ui/html/public/index.html`

**Purpose**
- App shell, navigation, and wallet status.

**Key DOM ids**
- `wallet-status`, `wallet-dot`, `wallet-account`, `wallet-hint`.
- `page-frame` for iframe navigation.

**Wallet logic**
- `eth_accounts` for read and `eth_requestAccounts` for connect.
- `accountsChanged` reloads iframe to ensure page state refresh.

**Navigation**
- `markets`, `portfolio`, `ttoken`, `trade`, `admin`.
- Each page is loaded in the iframe with `page-frame.src`.

### 3.2 Markets
**File**: `scripts/ui/dataFetch/tsla-yahoo/chart.html`

**Purpose**
- Candle chart and stock info with live price polling.

**Endpoints used**
- `GET /api/candles?symbol=SYMBOL&date=YYYY-MM-DD&interval=5&range=1d`
- `GET /api/fmp/quote-short?symbol=SYMBOL`
- `GET /api/fmp/stock-info?symbol=SYMBOL`

**Live price polling**
- Live price refresh every 10 seconds.
- Updated seconds refresh every 1 second.
- Toggle button enables or disables polling.

### 3.3 Portfolio
**File**: `scripts/ui/html/public/portfolio.html`

**Purpose**
- Displays equity balances and cash balance (TToken).

**Endpoints used**
- `GET /api/equity/balances?address=WALLET`
- `GET /api/ttoken/balance?address=WALLET`
- `GET /api/fmp/quote-short?symbol=SYMBOL`

**Notes**
- Cost price and gain or loss are placeholders shown as `x`.
- Clicking a row opens `sell.html?symbol=SYMBOL`.

### 3.4 Trade
**File**: `scripts/ui/html/public/trade.html`

**Purpose**
- Places buy orders on chain.

**Endpoint used**
- `POST /api/orderbook/limit`

**Payload**
```
{
  "symbol": "AAPL",
  "side": "BUY",
  "priceCents": 39500,
  "qty": 1000,
  "from": "0xWALLET"
}
```

**Auto buy**
- UI only. Uses the same endpoint with `auto-price` and `auto-qty` inputs.

### 3.5 Sell
**File**: `scripts/ui/html/public/sell.html`

**Purpose**
- Places sell orders on chain.

**Endpoint used**
- `POST /api/orderbook/limit`

**Payload**
```
{
  "symbol": "AAPL",
  "side": "SELL",
  "priceCents": 42000,
  "qty": 1000,
  "from": "0xWALLET"
}
```

### 3.6 TToken and Equity Mint
**File**: `scripts/ui/html/public/ttoken.html`

**Purpose**
- Mint TToken to current wallet.
- Create or mint equity tokens to current wallet.

**Endpoints used**
- `POST /api/ttoken/mint`
- `POST /api/equity/create-mint`

**Payloads**
```
{
  "to": "0xWALLET",
  "amount": 1000
}
```
```
{
  "symbol": "AAPL",
  "name": "Apple",
  "to": "0xWALLET",
  "amount": 1000
}
```

### 3.7 Admin
**File**: `scripts/ui/html/public/admin.html`

**Purpose**
- Displays open orders and completed fills.

**Endpoints used**
- `GET /api/orderbook/open`
- `GET /api/orderbook/fills`

**Order filtering**
- Only orders with `active === true` and `remaining > 0` are shown in open orders.

## 4) Backend REST API

**File**: `scripts/ui/html/server.js`

### 4.1 Market data

**GET /api/stock/:symbol**
- Yahoo quoteSummary modules: price, summaryDetail, financialData, majorHoldersBreakdown, institutionOwnership, fundOwnership, insiderHolders, insiderTransactions.

**GET /api/quote?symbol=SYMBOL**
- Yahoo quote with candle fallback.

**GET /api/fmp/quote-short?symbol=SYMBOL**
- FMP primary, Yahoo and candle fallback.
- Response:
```
{
  "symbol": "TSLA",
  "price": 400.5,
  "volume": 12345678,
  "stale": false,
  "source": "fmp"
}
```

**GET /api/fmp/stock-info?symbol=SYMBOL**
- FMP `quote` and `aftermarket-quote` combined, Yahoo and candle fallback.
- Response fields: previousClose, open, dayLow, dayHigh, yearLow, yearHigh, volume, avgVolume, marketCap, beta, peTTM, epsTTM, bid, bidSize, ask, askSize.

### 4.2 Candles

**GET /api/candles?symbol=SYMBOL&date=YYYY-MM-DD&interval=5&range=1d**
- Range mapping: 1d, 5d, 1m, 3m, 6m.
- Response:
```
{
  "symbol": "TSLA",
  "date": "2026-02-06",
  "interval": 5,
  "range": "1d",
  "dates": ["2026-02-06"],
  "candles": [
    {
      "timeSec": 1707229800,
      "open": 411.2,
      "high": 412.1,
      "low": 410.8,
      "close": 411.1,
      "volume": 10230,
      "timeET": "02/06/2026, 09:30"
    }
  ]
}
```

### 4.3 Hardhat accounts

**GET /api/hardhat/accounts**
- Response:
```
{
  "accounts": ["0xWALLET0", "0xWALLET1"]
}
```

### 4.4 TToken

**GET /api/ttoken-address**
- Returns TToken address from deployments or environment.

**GET /api/ttoken/balance?address=0xWALLET**
- Response:
```
{
  "address": "0xWALLET",
  "ttokenAddress": "0xTTOKEN",
  "balanceWei": "1000000000000000000000"
}
```

**POST /api/ttoken/mint**
- Body: `to`, `amount`.
- Sender: `deployments.admin`.
- Response: `{ "txHash": "0xTX" }`.

### 4.5 Equity tokens

**GET /api/registry/listings**
- Response:
```
{
  "listings": [
    { "symbol": "AAPL", "tokenAddress": "0xTOKEN" }
  ]
}
```

**GET /api/equity/address?symbol=SYMBOL**
- Response: `{ "tokenAddress": "0xTOKEN" }`.

**GET /api/equity/balances?address=0xWALLET**
- Response:
```
{
  "balances": [
    { "symbol": "AAPL", "tokenAddress": "0xTOKEN", "balanceWei": "1000000000000000000000" }
  ]
}
```

**POST /api/equity/create**
- Body: `symbol`, `name`.
- Response: `{ "txHash": "0xTX" }`.

**POST /api/equity/mint**
- Body: `symbol`, `to`, `amount`.
- Response: `{ "txHash": "0xTX", "tokenAddress": "0xTOKEN" }`.

**POST /api/equity/create-mint**
- Body: `symbol`, `name`, `to`, `amount`.
- Response:
```
{
  "createTx": "0xTX",
  "mintTx": "0xTX",
  "tokenAddress": "0xTOKEN"
}
```

### 4.6 Order book

**POST /api/orderbook/limit**
- Body: `symbol`, `side`, `priceCents`, `qty`, `from`.
- Behavior:
  - Resolve token from registry.
  - Convert `qty` to 18 decimal units.
  - For BUY, compute `quoteWei = qtyWei * priceCents / 100`.
  - Approve TToken for BUY or equity token for SELL.
  - Call `OrderBookDEX.placeLimitOrder`.
- Response: `{ "txHash": "0xTX" }`.

**GET /api/orderbook/open**
- Response:
```
{
  "orders": [
    {
      "id": 1,
      "side": "BUY",
      "symbol": "AAPL",
      "priceCents": 42000,
      "qty": "1000000000000000000000",
      "remaining": "500000000000000000000",
      "trader": "0xWALLET",
      "active": true
    }
  ]
}
```

**GET /api/orderbook/fills**
- Response:
```
{
  "fills": [
    {
      "makerId": 1,
      "takerId": 2,
      "makerTrader": "0xWALLET",
      "takerTrader": "0xWALLET",
      "symbol": "AAPL",
      "priceCents": 42000,
      "qty": "1000000000000000000000",
      "blockNumber": 50,
      "txHash": "0xTX",
      "timestampMs": 1700000000000
    }
  ]
}
```

## 5) Contract Implementation Details

### 5.1 TToken
- ERC20 with 18 decimals.
- Constants for max supply and airdrop amount.
- `airdropOnce` checks and records claim in `airdropClaimed`.

### 5.2 ListingsRegistry
- Mapping from symbol key to Listing struct.
- `LISTING_ROLE` controls registerListing.

### 5.3 EquityToken
- ERC20 with 18 decimals.
- Includes snapshot functionality.

### 5.4 EquityTokenFactory
- Deploys EquityToken and registers listing.
- Grants minter role to default minter.

### 5.5 OrderBookDEX
- Escrow based order book.
- Orders stored in buyOrders and sellOrders arrays.
- Matching logic inside `matchOrder` for cross fills.
- Emits OrderPlaced and OrderFilled used by admin UI.

### 5.6 PriceFeed
- Stores price and timestamp per symbol.
- `isFresh` checks timestamp window.

### 5.7 Dividends
- Deployed but not wired to API or UI.

### 5.8 Award
- Deployed but not wired to API or UI.

### 5.9 PortfolioAggregator
- Deployed but not wired to API or UI.

## 6) Deployment

### 6.1 Stage 1
- `scripts/stage1/deploy.js` deploys TToken and writes deployments.

### 6.2 Stage 2
- `scripts/deployStage2.js` deploys ListingsRegistry, EquityTokenFactory, PriceFeed.
- Creates default listings for AAPL, TSLA, LSE.

### 6.3 Stage 4
- `scripts/stage4/deploy.js` deploys OrderBookDEX.

### 6.4 Stage 5
- `scripts/stage5/deploy.js` deploys Dividends.

## 7) Missing Components

- Cost basis and profit calculations are placeholders.
- Auto buy and auto sell are UI only.
- Dividends not wired to UI or API.
- No order cancel UI.
- No pagination for order book or fills.
- No authentication or admin access control in backend.
- No off chain indexer.
- No database persistence.
- No monitoring dashboards.
- No automated test coverage for UI or API.

## 8) Demonstration Plan and Marking Criteria Alignment

### 8.1 Demonstration objectives
- Show concrete progress against deliverables.
- Show adherence to plan and staged development.
- Show problem solving and technical decisions.
- Explain clearly with direct linkage to code and on chain behavior.

### 8.2 Demo script and flow

**Phase 1: Setup evidence**
- Show `npm run dev:chain` output with deployments written to `deployments/localhost.json`.
- Point to `ttoken`, `listingsRegistry`, `equityTokenFactory`, `priceFeed`, `orderBookDex` entries.

**Phase 2: Core on chain functionality**
- Open `ttoken.html` and mint 1000 TToken to the connected wallet.
- Import TToken in MetaMask and show balance.
- Use `equity` mint to create or mint AAPL equity to wallet.

**Phase 3: Market data integration**
- Open markets page, load TSLA candles.
- Show live price update toggle and stock info snapshot.

**Phase 4: Trading workflow**
- Place a BUY order from trade page.
- Place a SELL order from sell page for the same symbol.
- Observe order matching in admin page.

**Phase 5: Admin and on chain evidence**
- Open admin page to show open orders and completed fills.
- Explain that fills are read from OrderFilled logs.
- Show block timestamp mapping to local time.

### 8.3 Mapping to marking criteria

**Progress towards deliverables**
- Working deployment scripts and contract deployments.
- Market data integration and live price polling.
- Order book order placement and fill tracking.

**Application of planning**
- Stage based deploy scripts and contract separation.
- UI modules aligned with staged contract features.

**Problem solving ability**
- Demonstrate fallback data flow for FMP and Yahoo.
- Show on chain approval and order submission path.

**Clarity of explication**
- Use UI, API, and contract code to point to exact logic.
- Explain each step and show the exact REST payloads.

