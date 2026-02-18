# Stage 4 Script Usage — OrderBookDEX

Use this guide to deploy and demo Stage 4 locally. Commands assume you are in the project root.

## Prerequisites

- Local node running: `npx hardhat node`
- TToken deployed (Stage 1)

## Deploy OrderBookDEX

```bash
export TTOKEN_ADDRESS=0xYourTTokenAddress
export LISTINGS_REGISTRY=0xYourListingsRegistryAddress
export PRICE_FEED_ADDRESS=0xYourPriceFeedAddress
npx hardhat run scripts/deploy-orderbook.js --network localhost
```

The deployed address is saved to `deployments/localhost.json` as `orderBookDex`.

## Demo a trade

```bash
export DEX_ADDRESS=0xYourOrderBookDex
export TTOKEN_ADDRESS=0xYourTTokenAddress
# Optional: use an existing EquityToken
export EQUITY_TOKEN_ADDRESS=0xYourEquityTokenAddress
# Optional overrides
export PRICE=10000   # $100.00 in cents
export QTY=1000000000000000000 # 1.0 share (18dp)

npx hardhat run scripts/stage4/demo.js --network localhost
```

If `EQUITY_TOKEN_ADDRESS` is not set, the demo deploys a fresh EquityToken.

## Tests

```bash
npx hardhat test test/orderbook-dex.test.js
```
