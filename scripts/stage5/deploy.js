





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
    return { filePath, data: JSON.parse(raw) };
  } catch (err) {
    return { filePath, data: {} };
  }
}

async function writeDeployments(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2) + "\n");
}

async function main() {
  const [admin] = await ethers.getSigners();
  const { filePath, data } = await readDeployments(network.name);

  const ttoken = data.ttoken || data.ttokenAddress || data.TTOKEN_ADDRESS;
  const registry = data.listingsRegistry;
  if (ttoken === undefined || ttoken === null || registry === undefined || registry === null) {
    throw new Error("Missing ttoken or listingsRegistry in deployments.");
  }

  const Dividends = await ethers.getContractFactory("Dividends");
  const dividends = await Dividends.deploy(ttoken, registry, admin.address);
  await dividends.waitForDeployment();

  const dividendsAddress = await dividends.getAddress();
  const updated = { ...data, dividends: dividendsAddress };
  await writeDeployments(filePath, updated);

  console.log("Dividends deployed to:", dividendsAddress);
  console.log("Updated deployments:", filePath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
