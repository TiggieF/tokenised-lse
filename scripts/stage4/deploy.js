




const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeDeployment(networkName, payload) {
  const dir = path.join(__dirname, "..", "..", "deployments");
  await ensureDir(dir);
  const filePath = path.join(dir, `${networkName}.json`);
  let existing = {};
  if (fs.existsSync(filePath)) {
    existing = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  }
  const merged = { ...existing, ...payload };
  await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2));
  return filePath;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deploymentsPath = path.join(__dirname, "..", "..", "deployments", `${network.name}.json`);
  const deployments = JSON.parse(await fs.promises.readFile(deploymentsPath, "utf8"));
  const ttokenAddress = deployments.ttoken;
  const registryAddress = deployments.listingsRegistry;
  const priceFeedAddress = deployments.priceFeed;

  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);
  console.log("TToken:", ttokenAddress);
  const OrderBookDEX = await ethers.getContractFactory("OrderBookDEX");
  const dex = await OrderBookDEX.deploy(ttokenAddress, registryAddress, priceFeedAddress);
  await dex.waitForDeployment();

  const payload = {
    orderBookDex: await dex.getAddress(),
  };

  const outputPath = await writeDeployment(network.name, payload);
  console.log("OrderBookDEX deployed to:", await dex.getAddress());
  console.log("Deployment saved to:", outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
