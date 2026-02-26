const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeDeployment(networkName, payload) {
  const dir = path.join(__dirname, "..", "deployments");
  await ensureDir(dir);

  const filePath = path.join(dir, `${networkName}.json`);
  let existing = {};

  if (fs.existsSync(filePath)) {
    const raw = await fs.promises.readFile(filePath, "utf8");
    existing = JSON.parse(raw);
  }

  const merged = {
    ...existing,
    ...payload,
  };

  await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2));
  return filePath;
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  const deploymentsPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const raw = await fs.promises.readFile(deploymentsPath, "utf8");
  const deployments = JSON.parse(raw);

  const ttokenAddress = deployments.ttoken;
  const registryAddress = deployments.listingsRegistry;
  const priceFeedAddress = deployments.priceFeed;

  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);
  console.log("TToken:", ttokenAddress);

  const dexFactory = await ethers.getContractFactory("OrderBookDEX");
  const dex = await dexFactory.deploy(ttokenAddress, registryAddress, priceFeedAddress);
  await dex.waitForDeployment();

  const dexAddress = await dex.getAddress();
  const payload = {
    orderBookDex: dexAddress,
  };

  const outputPath = await writeDeployment(network.name, payload);
  console.log("OrderBookDEX deployed to:", dexAddress);
  console.log("Deployment saved to:", outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
