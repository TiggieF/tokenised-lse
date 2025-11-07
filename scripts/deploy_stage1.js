// scripts/deploy_stage1.js
// -----------------------------------------------------------------------------
// This script deploys the TGBP token to the currently selected Hardhat network.
// It provides verbose logging so that team members who are new to Hardhat can
// verify which account performed the deployment and what the key token
// parameters are (max supply and airdrop amount).
// -----------------------------------------------------------------------------

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying TGBP with account:", deployer.address);
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("Account balance:", balance.toString());

  const TGBP = await ethers.getContractFactory("TGBP");
  const tgbp = await TGBP.deploy();
  await tgbp.waitForDeployment();

  console.log("TGBP deployed to:", await tgbp.getAddress());
  console.log("Max supply:", (await tgbp.MAX_SUPPLY()).toString());
  console.log("Airdrop amount:", (await tgbp.AIRDROP_AMOUNT()).toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
