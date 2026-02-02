// scripts/stage1/deploy.js
// -----------------------------------------------------------------------------
// This script deploys the TToken token to the currently selected Hardhat network.
// It provides verbose logging so that team members who are new to Hardhat can
// verify which account performed the deployment and what the key token
// parameters are (max supply and airdrop amount).
// -----------------------------------------------------------------------------

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying TToken with account:", deployer.address);
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("Account balance:", balance.toString());

  const TToken = await ethers.getContractFactory("TToken");
  const ttoken = await TToken.deploy();
  await ttoken.waitForDeployment();

  console.log("TToken deployed to:", await ttoken.getAddress());
  console.log("Max supply:", (await ttoken.MAX_SUPPLY()).toString());
  console.log("Airdrop amount:", (await ttoken.AIRDROP_AMOUNT()).toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
