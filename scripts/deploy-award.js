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
  const signers = await ethers.getSigners();
  const admin = signers[0];

  const deploymentState = await readDeployments(network.name);
  const filePath = deploymentState.filePath;
  const data = deploymentState.data;

  const ttoken = readTtokenValue(data);
  const dex = data.orderBookDex;
  if (!ttoken || !dex) {
    throw new Error("Missing ttoken or orderBookDex in deployments.");
  }

  const awardFactory = await ethers.getContractFactory("Award");
  const award = await awardFactory.deploy(ttoken, admin.address, dex);
  await award.waitForDeployment();

  const awardAddress = await award.getAddress();
  const ttokenContract = await ethers.getContractAt("TToken", ttoken);
  const minterRole = await ttokenContract.MINTER_ROLE();
  await (await ttokenContract.connect(admin).grantRole(minterRole, awardAddress)).wait();

  const dexContract = await ethers.getContractAt("OrderBookDEX", dex);
  await (await dexContract.connect(admin).setAward(awardAddress)).wait();

  const updated = {
    ...data,
    award: awardAddress,
  };
  await writeDeployments(filePath, updated);

  console.log("Award deployed to:", awardAddress);
  console.log("Updated deployments:", filePath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
