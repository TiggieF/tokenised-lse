const { ethers } = require("hardhat");

const DEFAULT_PRICE_FEED_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEFAULT_ADMIN_ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

function requireAddress(value, name) {
  const hasValue = Boolean(value);
  let isValidAddress = false;

  if (hasValue) {
    isValidAddress = ethers.isAddress(value);
  }

  if (!isValidAddress) {
    throw new Error(`${name} must be a valid address`);
  }
}

async function handleGrantOracle(feed, admin, value) {
  requireAddress(value, "oracle");
  const role = await feed.ORACLE_ROLE();
  const tx = await feed.connect(admin).grantRole(role, value);
  await tx.wait();
  console.log("Granted ORACLE_ROLE to:", value);
}

async function handleRevokeOracle(feed, admin, value) {
  requireAddress(value, "oracle");
  const role = await feed.ORACLE_ROLE();
  const tx = await feed.connect(admin).revokeRole(role, value);
  await tx.wait();
  console.log("Revoked ORACLE_ROLE from:", value);
}

async function handleSetFreshnessWindow(feed, admin, value) {
  const secs = Number.parseInt(value, 10);
  const isValidSecs = Number.isFinite(secs) && secs > 0;

  if (!isValidSecs) {
    throw new Error("setFreshnessWindow requires a positive integer");
  }

  const tx = await feed.connect(admin).setFreshnessWindow(secs);
  await tx.wait();
  console.log("Freshness window set to:", secs);
}

async function handleReadPrice(feed, value) {
  if (!value) {
    throw new Error("readPrice requires a symbol (A-Z/0-9)");
  }

  const priceData = await feed.getPrice(value);
  const priceCents = priceData[0];
  const timestamp = priceData[1];
  const fresh = await feed.isFresh(value);
  const freshnessWindow = await feed.freshnessWindowSeconds();

  console.log("Symbol:", value);
  console.log("Price (cents):", priceCents.toString());
  console.log("Timestamp:", timestamp.toString());
  console.log("Is fresh:", fresh);
  console.log("Freshness window (secs):", freshnessWindow.toString());
}

async function main() {
  const envAddress = process.env.PRICE_FEED_ADDRESS;
  const priceFeedAddress = envAddress || DEFAULT_PRICE_FEED_ADDRESS;
  requireAddress(priceFeedAddress, "PRICE_FEED_ADDRESS");

  const signers = await ethers.getSigners();
  let admin = signers[0];

  for (let i = 0; i < signers.length; i += 1) {
    const signer = signers[i];
    if (signer.address === DEFAULT_ADMIN_ADDRESS) {
      admin = signer;
      break;
    }
  }

  const feed = await ethers.getContractAt("PriceFeed", priceFeedAddress);

  const args = process.argv.slice(2);
  const command = args[0];
  const value = args[1];

  if (!command) {
    throw new Error("Missing command. Use grantOracle|revokeOracle|setFreshnessWindow|readPrice");
  }

  if (command === "grantOracle") {
    await handleGrantOracle(feed, admin, value);
  } else if (command === "revokeOracle") {
    await handleRevokeOracle(feed, admin, value);
  } else if (command === "setFreshnessWindow") {
    await handleSetFreshnessWindow(feed, admin, value);
  } else if (command === "readPrice") {
    await handleReadPrice(feed, value);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
