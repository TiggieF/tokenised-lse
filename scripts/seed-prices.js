const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const DEFAULT_PRICES = {
  AAPL: 26618,
  TSLA: 23000,
  NVDA: 12000,
};

async function readDeployments(networkName) {
  const filePath = path.join(__dirname, "..", "deployments", `${networkName}.json`);
  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const prices = { ...DEFAULT_PRICES };
  for (let i = 0; i < argv.length; i += 1) {
    const value = String(argv[i] || "");
    if (!value.includes("=")) {
      continue;
    }
    const [symbolRaw, centsRaw] = value.split("=");
    const symbol = symbolRaw.toUpperCase().trim();
    const cents = Number(centsRaw);
    if (!symbol) {
      continue;
    }
    if (!Number.isFinite(cents) || cents <= 0) {
      continue;
    }
    prices[symbol] = Math.round(cents);
  }
  return prices;
}

async function main() {
  const deployments = await readDeployments(network.name);
  const priceFeedAddress = deployments.priceFeed;
  if (!priceFeedAddress) {
    throw new Error(`Missing priceFeed in deployments/${network.name}.json`);
  }

  const signers = await ethers.getSigners();
  const admin = signers[0];
  const prices = parseArgs(process.argv.slice(2));
  const symbols = Object.keys(prices);

  const priceFeed = await ethers.getContractAt("PriceFeed", priceFeedAddress);
  const oracleRole = await priceFeed.ORACLE_ROLE();
  const hasOracleRole = await priceFeed.hasRole(oracleRole, admin.address);
  if (!hasOracleRole) {
    throw new Error(`Signer ${admin.address} does not have ORACLE_ROLE on ${priceFeedAddress}`);
  }

  console.log("Network:", network.name);
  console.log("Admin:", admin.address);
  console.log("PriceFeed:", priceFeedAddress);

  for (let i = 0; i < symbols.length; i += 1) {
    const symbol = symbols[i];
    const priceCents = prices[symbol];
    const tx = await priceFeed.connect(admin).setPrice(symbol, BigInt(priceCents));
    const receipt = await tx.wait();
    const [storedPrice, storedTimestamp] = await priceFeed.getPrice(symbol);
    console.log(
      `Set ${symbol}=${priceCents} cents tx=${tx.hash} status=${receipt.status} stored=${storedPrice.toString()} ts=${storedTimestamp.toString()}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
