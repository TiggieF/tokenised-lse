// scripts/stage3/updatePriceFromFinnhub.js
// -----------------------------------------------------------------------------
// Fetches a live quote from Finnhub and pushes it to the on-chain PriceFeed.
// Intended for local testing and backend wiring.
// -----------------------------------------------------------------------------

const { ethers } = require("hardhat");

const DEFAULT_PRICE_FEED_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEFAULT_FINNHUB_API_KEY = "d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0";
const DEFAULT_ORACLE_ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

async function fetchFinnhubQuote(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    symbol
  )}&token=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`Finnhub request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data || typeof data.c !== "number") {
    throw new Error("Finnhub response missing price data");
  }

  return data;
}

function toCents(quote) {
  const price = quote.c;
  if (price === undefined || price === null) {
    throw new Error("Finnhub response missing current price");
  }

  return Math.round(price * 100);
}

async function main() {
  const priceFeedAddress = process.env.PRICE_FEED_ADDRESS || DEFAULT_PRICE_FEED_ADDRESS;
  const symbol = process.env.SYMBOL;
  const finnhubSymbol = process.env.FINNHUB_SYMBOL || symbol;
  const apiKey = process.env.FINNHUB_API_KEY || DEFAULT_FINNHUB_API_KEY;
  const signerIndex = Number.parseInt(process.env.ORACLE_SIGNER_INDEX || "2", 10);

  if (!symbol) {
    throw new Error("Set SYMBOL env var (A-Z/0-9)");
  }

  const signers = await ethers.getSigners();
  let oracle = signers.find((signer) => signer.address === DEFAULT_ORACLE_ADDRESS);
  if (!oracle && !Number.isNaN(signerIndex)) {
    if (signerIndex < 0 || signerIndex >= signers.length) {
      throw new Error(`Invalid ORACLE_SIGNER_INDEX ${process.env.ORACLE_SIGNER_INDEX}`);
    }
    oracle = signers[signerIndex];
  }
  if (!oracle) {
    throw new Error(`Oracle signer ${DEFAULT_ORACLE_ADDRESS} not found in this network`);
  }
  const feed = await ethers.getContractAt("PriceFeed", priceFeedAddress);

  const quote = await fetchFinnhubQuote(finnhubSymbol, apiKey);
  const priceCents = toCents(quote);

  console.log(`Finnhub ${finnhubSymbol} price:`, quote.c, "USD");
  console.log(`Setting ${symbol} to ${priceCents} cents on-chain...`);

  const tx = await feed.connect(oracle).setPrice(symbol, priceCents);
  await tx.wait();

  const [storedPrice, timestamp] = await feed.getPrice(symbol);
  console.log("Stored price:", storedPrice.toString(), "cents");
  console.log("Timestamp:", timestamp.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
