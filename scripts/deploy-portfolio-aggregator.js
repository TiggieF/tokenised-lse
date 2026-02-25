const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function readDeployments(networkName) {
  const filePath = path.join(__dirname, "..", "deployments", `${networkName}.json`);
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return { filePath, data: JSON.parse(raw) };
  } catch {
    return { filePath, data: {} };
  }
}

async function writeDeployments(filePath, payload) {
  const dirPath = path.dirname(filePath);
  await ensureDir(dirPath);
  const body = JSON.stringify(payload, null, 2) + "\n";
  await fs.promises.writeFile(filePath, body);
}

function readTtokenValue(data) {
  if (data.ttoken) {
    return data.ttoken;
  }
  if (data.ttokenAddress) {
    return data.ttokenAddress;
  }
  if (data.TTOKEN_ADDRESS) {
    return data.TTOKEN_ADDRESS;
  }
  return "";
}

async function main() {
  const deploymentState = await readDeployments(network.name);
  const filePath = deploymentState.filePath;
  const data = deploymentState.data;

  const ttoken = readTtokenValue(data);
  const registry = data.listingsRegistry;
  const priceFeed = data.priceFeed;
  if (!ttoken || !registry || !priceFeed) {
    throw new Error("Missing ttoken, listingsRegistry, or priceFeed in deployments.");
  }

  const aggregatorFactory = await ethers.getContractFactory("PortfolioAggregator");
  const aggregator = await aggregatorFactory.deploy(ttoken, registry, priceFeed);
  await aggregator.waitForDeployment();

  const aggregatorAddress = await aggregator.getAddress();
  const updated = {
    ...data,
    portfolioAggregator: aggregatorAddress,
  };
  await writeDeployments(filePath, updated);

  console.log("PortfolioAggregator deployed to:", aggregatorAddress);
  console.log("Updated deployments:", filePath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
