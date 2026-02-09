// scripts/deployStage2.js
// -----------------------------------------------------------------------------
// Deploys ListingsRegistry + EquityTokenFactory, optionally creates a few
// listings, and writes addresses to deployments/local.json.
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const DEFAULT_LISTINGS = [
  { symbol: "AAPL", name: "Apple Inc" },
  { symbol: "TSLA", name: "Tesla Inc" },
  { symbol: "LSE", name: "London Stock Exchange" },
];

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeDeployment(networkName, payload) {
  const dir = path.join(__dirname, "..", "deployments");
  await ensureDir(dir);
  const filePath = path.join(dir, `${networkName}.json`);
  let existing = {};
  try {
    existing = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (err) {
    existing = {};
  }
  const merged = { ...existing, ...payload };
  await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2) + "\n");
  return filePath;
}

async function main() {
  const [admin, defaultMinter] = await ethers.getSigners();
  const shouldCreateListings = process.env.CREATE_LISTINGS !== "false";

  console.log("Network:", network.name);
  console.log("Admin:", admin.address);
  console.log("Default minter:", defaultMinter.address);

  const ListingsRegistry = await ethers.getContractFactory("ListingsRegistry");
  const registry = await ListingsRegistry.deploy(admin.address);
  await registry.waitForDeployment();

  const EquityTokenFactory = await ethers.getContractFactory("EquityTokenFactory");
  const factory = await EquityTokenFactory.deploy(
    admin.address,
    await registry.getAddress(),
    defaultMinter.address
  );
  await factory.waitForDeployment();

  const listingRole = await registry.LISTING_ROLE();
  await registry.connect(admin).grantRole(listingRole, await factory.getAddress());

  const PriceFeed = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await PriceFeed.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  if (shouldCreateListings) {
    for (const listing of DEFAULT_LISTINGS) {
      const tx = await factory.connect(admin).createEquityToken(listing.symbol, listing.name);
      await tx.wait();
      const [tokenAddr, sym, name] = await registry.getListingFull(listing.symbol);
      console.log(`Listed ${sym} (${name}):`, tokenAddr);
    }
  }

  const payload = {
    network: network.name,
    admin: admin.address,
    defaultMinter: defaultMinter.address,
    listingsRegistry: await registry.getAddress(),
    equityTokenFactory: await factory.getAddress(),
    priceFeed: await priceFeed.getAddress(),
  };

  const outputPath = await writeDeployment(network.name, payload);
  console.log("Deployment saved to:", outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
