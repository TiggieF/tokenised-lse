const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DEFAULT_FINNHUB_API_KEY = "d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0";
const DEFAULT_ORACLE_ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

function loadDeployments(networkName) {
  const deploymentsPath = path.join(__dirname, "..", "..", "deployments", `${networkName}.json`);
  const raw = fs.readFileSync(deploymentsPath, "utf8");
  return JSON.parse(raw);
}

async function fetchFinnhubQuote(symbol, apiKey) {
  const encodedSymbol = encodeURIComponent(symbol);
  const encodedApiKey = encodeURIComponent(apiKey);
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodedSymbol}&token=${encodedApiKey}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`Finnhub request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const hasPrice = data && typeof data.c === "number";
  if (!hasPrice) {
    throw new Error("Finnhub response missing price data");
  }

  return data;
}

function toCents(quote) {
  const price = quote.c;
  const cents = Math.round(price * 100);
  return cents;
}

async function findOracleSigner(signers, fallbackIndex) {
  for (let i = 0; i < signers.length; i += 1) {
    const signer = signers[i];
    if (signer.address === DEFAULT_ORACLE_ADDRESS) {
      return signer;
    }
  }

  const indexIsValid = !Number.isNaN(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < signers.length;
  if (indexIsValid) {
    return signers[fallbackIndex];
  }

  return null;
}

async function main() {
  const deployments = loadDeployments("localhost");

  const envPriceFeedAddress = process.env.PRICE_FEED_ADDRESS;
  const priceFeedAddress = envPriceFeedAddress || deployments.priceFeed;

  const symbol = process.env.SYMBOL;
  const finnhubSymbol = process.env.FINNHUB_SYMBOL || symbol;
  const apiKey = process.env.FINNHUB_API_KEY || DEFAULT_FINNHUB_API_KEY;

  const rawSignerIndex = process.env.ORACLE_SIGNER_INDEX || "2";
  const signerIndex = Number.parseInt(rawSignerIndex, 10);

  if (!symbol) {
    throw new Error("Set SYMBOL env var (A-Z/0-9)");
  }

  const signers = await ethers.getSigners();
  const oracle = await findOracleSigner(signers, signerIndex);

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

  const priceData = await feed.getPrice(symbol);
  const storedPrice = priceData[0];
  const timestamp = priceData[1];

  console.log("Stored price:", storedPrice.toString(), "cents");
  console.log("Timestamp:", timestamp.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
