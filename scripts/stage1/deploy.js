

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
// contract deploy for ttoken
// helpers for ether nodejs and path

async function main() {
  const [deployer] = await ethers.getSigners();
  // deploy with the first account, act as admin
  console.log("deploying TToken with account:", deployer.address);

  const balance = await deployer.provider.getBalance(deployer.address);
  // read eth balance for gas usage
  console.log("Account balance:", balance.toString());

  const TToken = await ethers.getContractFactory("TToken");
  const ttoken = await TToken.deploy();
  // gets contract and deploy
  await ttoken.waitForDeployment();
  // wait deployment to be mined

  const ttokenAddress = await ttoken.getAddress();
  console.log("TToken deployed to:", ttokenAddress);
  console.log("Max supply:", (await ttoken.MAX_SUPPLY()).toString());
  console.log("Airdrop amount:", (await ttoken.AIRDROP_AMOUNT()).toString());

  if (network.name === "localhost" || network.name === "hardhat") {
    // testing for local now

    const deploymentsPath = path.join(__dirname, "..", "..", "deployments", "localhost.json");
    // save to json
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
