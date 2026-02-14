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
    const raw = await fs.promises.readFile(filePath, "utf8");
    existing = JSON.parse(raw);
  } catch (readError) {
    existing = {};
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
  const admin = signers[0];
  const defaultMinter = signers[1];

  let shouldCreateListings = true;
  if (process.env.CREATE_LISTINGS === "false") {
    shouldCreateListings = false;
  }

  console.log("Network:", network.name);
  console.log("Admin:", admin.address);
  console.log("Default minter:", defaultMinter.address);

  const listingsRegistryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await listingsRegistryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const equityTokenFactoryFactory = await ethers.getContractFactory("EquityTokenFactory");
  const registryAddress = await registry.getAddress();
  const tokenFactory = await equityTokenFactoryFactory.deploy(
    admin.address,
    registryAddress,
    defaultMinter.address
  );
  await tokenFactory.waitForDeployment();

  const listingRole = await registry.LISTING_ROLE();
  const tokenFactoryAddress = await tokenFactory.getAddress();
  const grantTx = await registry.connect(admin).grantRole(listingRole, tokenFactoryAddress);
  await grantTx.wait();

  const priceFeedFactory = await ethers.getContractFactory("PriceFeed");
  const priceFeed = await priceFeedFactory.deploy(admin.address, admin.address);
  await priceFeed.waitForDeployment();

  if (shouldCreateListings) {
    for (let i = 0; i < DEFAULT_LISTINGS.length; i += 1) {
      const listing = DEFAULT_LISTINGS[i];
      const createTx = await tokenFactory.connect(admin).createEquityToken(listing.symbol, listing.name);
      await createTx.wait();

      const listingData = await registry.getListingFull(listing.symbol);
      const tokenAddress = listingData[0];
      const symbol = listingData[1];
      const name = listingData[2];
      console.log(`Listed ${symbol} (${name}):`, tokenAddress);
    }
  }

  const payload = {
    network: network.name,
    admin: admin.address,
    defaultMinter: defaultMinter.address,
    listingsRegistry: registryAddress,
    equityTokenFactory: tokenFactoryAddress,
    priceFeed: await priceFeed.getAddress(),
  };

  const outputPath = await writeDeployment(network.name, payload);
  console.log("Deployment saved to:", outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
