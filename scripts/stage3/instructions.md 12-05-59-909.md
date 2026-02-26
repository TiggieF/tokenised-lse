# Stage 3 Script Usage — PriceFeed

Use this guide to push a live Yahoo Finance quote to the on-chain PriceFeed.

## Prerequisites

- Run a local node: `npx hardhat node`
- Deploy `PriceFeed.sol` (via console or a deploy script)
- Ensure the oracle account has ORACLE_ROLE (constructor grants admin + oracle)

## Update a price from Finnhub (USD only)

Defaults are hardcoded for the demo:
- PriceFeed: `0x5FbDB2315678afecb367f032d93F642f64180aa3`
- Oracle signer: `0x90F79bf6EB2c4f870365E785982E1f101E93b906`
- Finnhub key: `d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0`

```bash
export SYMBOL=ACME1
# Optional: Finnhub may use a different ticker (e.g. "BRK.B")
export FINNHUB_SYMBOL=ACME1

npx hardhat run scripts/stage3/updatePriceFromFinnhub.js --network localhost
```

### Optional overrides
You can still override the defaults if needed:

```bash
export PRICE_FEED_ADDRESS=0xYourPriceFeedAddress
export FINNHUB_API_KEY=your_finnhub_key_here
export ORACLE_SIGNER_INDEX=2
```

### Notes

- Symbols must be uppercase A–Z or 0–9 to match Stage 2.
- Finnhub quotes are assumed to be `USD` and are stored as integer cents.
- Non-USD currencies will error. If you need FX conversion, tell us.
- Recommended update cadence: no more than once every 5 seconds.
