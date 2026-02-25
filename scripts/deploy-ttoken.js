const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeDeployment(networkName, payload) {
  const dir = path.join(__dirname, "..", "deployments");
  await ensureDir(dir);

  const filePath = path.join(dir, `${networkName}.json`);
  let existing = {};

  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    existing = JSON.parse(raw);
  } catch {
    existing = { network: networkName };
  }

  const merged = {
    ...existing,
    ...payload,
  };

  const body = JSON.stringify(merged, null, 2) + "\n";
  await fs.promises.writeFile(filePath, body);
  return filePath;
}

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
  const outputPath = await writeDeployment(network.name, {
    network: network.name,
    ttoken: tokenAddress,
    ttokenAddress: tokenAddress,
  });
  console.log("Updated deployment file:", outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
