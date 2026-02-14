const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  console.log("deploying TToken with account:", deployer.address);

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("Account balance:", balance.toString());

  const tokenFactory = await ethers.getContractFactory("TToken");
  const token = await tokenFactory.deploy();
  await token.waitForDeployment();

  const tokenAddress = await token.getAddress();
  const maxSupply = await token.MAX_SUPPLY();
  const airdropAmount = await token.AIRDROP_AMOUNT();

  console.log("TToken deployed to:", tokenAddress);
  console.log("Max supply:", maxSupply.toString());
  console.log("Airdrop amount:", airdropAmount.toString());

  const isLocal = network.name === "localhost" || network.name === "hardhat";
  if (isLocal) {
    const deploymentsPath = path.join(__dirname, "..", "..", "deployments", "localhost.json");

    let deployments = {};
    try {
      const raw = fs.readFileSync(deploymentsPath, "utf8");
      deployments = JSON.parse(raw);
    } catch (readError) {
      deployments = { network: "localhost" };
    }

    deployments.ttoken = tokenAddress;

    const body = JSON.stringify(deployments, null, 2) + "\n";
    fs.writeFileSync(deploymentsPath, body);
    console.log("Updated deployments/localhost.json with TToken address.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
