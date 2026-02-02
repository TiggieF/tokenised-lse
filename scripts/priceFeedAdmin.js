// scripts/priceFeedAdmin.js
// -----------------------------------------------------------------------------
// Admin/oracle utilities for PriceFeed.
// Usage examples:
//  npx hardhat run scripts/priceFeedAdmin.js --network localhost -- grantOracle 0xOracle
//  npx hardhat run scripts/priceFeedAdmin.js --network localhost -- revokeOracle 0xOracle
//  npx hardhat run scripts/priceFeedAdmin.js --network localhost -- setFreshnessWindow 120
//  npx hardhat run scripts/priceFeedAdmin.js --network localhost -- readPrice ACME1
// -----------------------------------------------------------------------------

const { ethers } = require("hardhat");

const DEFAULT_PRICE_FEED_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEFAULT_ADMIN_ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

function requireAddress(value, name) {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} must be a valid address`);
  }
}

async function main() {
  const priceFeedAddress = process.env.PRICE_FEED_ADDRESS || DEFAULT_PRICE_FEED_ADDRESS;
  requireAddress(priceFeedAddress, "PRICE_FEED_ADDRESS");

  const signers = await ethers.getSigners();
  const admin = signers.find((signer) => signer.address === DEFAULT_ADMIN_ADDRESS) || signers[0];
  const feed = await ethers.getContractAt("PriceFeed", priceFeedAddress);

  const args = process.argv.slice(2);
  const command = args[0];
  const value = args[1];

  if (!command) {
    throw new Error("Missing command. Use grantOracle|revokeOracle|setFreshnessWindow|readPrice");
  }

  if (command === "grantOracle") {
    requireAddress(value, "oracle");
    const role = await feed.ORACLE_ROLE();
    const tx = await feed.connect(admin).grantRole(role, value);
    await tx.wait();
    console.log("Granted ORACLE_ROLE to:", value);
    return;
  }

  if (command === "revokeOracle") {
    requireAddress(value, "oracle");
    const role = await feed.ORACLE_ROLE();
    const tx = await feed.connect(admin).revokeRole(role, value);
    await tx.wait();
    console.log("Revoked ORACLE_ROLE from:", value);
    return;
  }

  if (command === "setFreshnessWindow") {
    const secs = Number.parseInt(value, 10);
    if (!Number.isFinite(secs) || secs <= 0) {
      throw new Error("setFreshnessWindow requires a positive integer");
    }
    const tx = await feed.connect(admin).setFreshnessWindow(secs);
    await tx.wait();
    console.log("Freshness window set to:", secs);
    return;
  }

  if (command === "readPrice") {
    if (!value) {
      throw new Error("readPrice requires a symbol (A-Z/0-9)");
    }
    const [priceCents, timestamp] = await feed.getPrice(value);
    console.log("Symbol:", value);
    console.log("Price (cents):", priceCents.toString());
    console.log("Timestamp:", timestamp.toString());
    console.log("Is fresh:", await feed.isFresh(value));
    console.log("Freshness window (secs):", (await feed.freshnessWindowSeconds()).toString());
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
