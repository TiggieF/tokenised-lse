// scripts/stage1/deploy.js
// -----------------------------------------------------------------------------
// This script deploys the TToken token to the currently selected Hardhat network.
// It provides verbose logging so that team members who are new to Hardhat can
// verify which account performed the deployment and what the key token
// parameters are (max supply and airdrop amount).
// -----------------------------------------------------------------------------

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying TToken with account:", deployer.address);
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("Account balance:", balance.toString());

  const TToken = await ethers.getContractFactory("TToken");
  const ttoken = await TToken.deploy();
  await ttoken.waitForDeployment();

  const ttokenAddress = await ttoken.getAddress();
  console.log("TToken deployed to:", ttokenAddress);
  console.log("Max supply:", (await ttoken.MAX_SUPPLY()).toString());
  console.log("Airdrop amount:", (await ttoken.AIRDROP_AMOUNT()).toString());

  if (network.name === "localhost" || network.name === "hardhat") {
    const deploymentsPath = path.join(__dirname, "..", "..", "deployments", "localhost.json");
    let deployments = {};
    try {
      deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    } catch (err) {
      deployments = { network: "localhost" };
    }
    deployments.ttoken = ttokenAddress;
    fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
    console.log("Updated deployments/localhost.json with TToken address.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
