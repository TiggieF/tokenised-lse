const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function readDeployments(networkName) {
  const filePath = path.join(__dirname, "..", "..", "deployments", `${networkName}.json`);

  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    return { filePath, data };
  } catch (readError) {
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
  let value = data.ttoken;

  if (!value) {
    value = data.ttokenAddress;
  }

  if (!value) {
    value = data.TTOKEN_ADDRESS;
  }

  return value;
}

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];

  const deploymentState = await readDeployments(network.name);
  const filePath = deploymentState.filePath;
  const data = deploymentState.data;

  const ttoken = readTtokenValue(data);
  const registry = data.listingsRegistry;

  if (!ttoken || !registry) {
    throw new Error("Missing ttoken or listingsRegistry in deployments.");
  }

  const dividendsFactory = await ethers.getContractFactory("Dividends");
  const dividends = await dividendsFactory.deploy(ttoken, registry, admin.address);
  await dividends.waitForDeployment();

  const dividendsAddress = await dividends.getAddress();
  const updated = {
    ...data,
    dividends: dividendsAddress,
  };

  await writeDeployments(filePath, updated);

  console.log("Dividends deployed to:", dividendsAddress);
  console.log("Updated deployments:", filePath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
