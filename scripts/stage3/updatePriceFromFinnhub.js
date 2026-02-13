
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
  return Math.round(price * 100);
  // price to cent
}

async function main() {
  const deployments = loadDeployments("localhost");
  const priceFeedAddress = process.env.PRICE_FEED_ADDRESS || deployments.priceFeed;
  // get price feed address from env or deployments
  const symbol = process.env.SYMBOL;
  // get symbol
  const finnhubSymbol = process.env.FINNHUB_SYMBOL || symbol;
  const apiKey = process.env.FINNHUB_API_KEY || DEFAULT_FINNHUB_API_KEY;
  const signerIndex = Number.parseInt(process.env.ORACLE_SIGNER_INDEX || "2", 10);
  

  if (!symbol) {
    throw new Error("Set SYMBOL env var (A-Z/0-9)");
    // check for symbol
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
  // fetch price and set on chain and double check
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
