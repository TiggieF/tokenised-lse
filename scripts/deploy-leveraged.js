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

function readTtokenAddress(data) {
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

  const registryAddress = data.listingsRegistry;
  const priceFeedAddress = data.priceFeed;
  const ttokenAddress = readTtokenAddress(data);

  if (!registryAddress || !priceFeedAddress || !ttokenAddress) {
    throw new Error("Missing listingsRegistry, priceFeed, or ttoken in deployments");
  }

  const factoryFactory = await ethers.getContractFactory("LeveragedTokenFactory");
  const leveragedFactory = await factoryFactory.deploy(admin.address, registryAddress);
  await leveragedFactory.waitForDeployment();

  const routerFactory = await ethers.getContractFactory("LeveragedProductRouter");
  const leveragedRouter = await routerFactory.deploy(
    admin.address,
    ttokenAddress,
    priceFeedAddress,
    await leveragedFactory.getAddress()
  );
  await leveragedRouter.waitForDeployment();

  const setRouterTx = await leveragedFactory.connect(admin).setRouter(await leveragedRouter.getAddress());
  await setRouterTx.wait();

  const registry = new ethers.Contract(
    registryAddress,
    [
      "function isListed(string memory symbol) external view returns (bool)",
    ],
    admin
  );

  const defaultProducts = [
    { baseSymbol: "TSLA", leverage: 5 },
    { baseSymbol: "AAPL", leverage: 5 },
  ];

  for (let i = 0; i < defaultProducts.length; i += 1) {
    const one = defaultProducts[i];
    let listed = false;
    try {
      listed = await registry.isListed(one.baseSymbol);
    } catch (listError) {
      listed = false;
    }

    if (listed) {
      try {
        const createTx = await leveragedFactory.connect(admin).createLongProduct(one.baseSymbol, one.leverage);
        await createTx.wait();
        console.log(`created default leveraged product ${one.baseSymbol}${one.leverage}L`);
      } catch (createError) {
        console.log(`default leveraged product skipped for ${one.baseSymbol}${one.leverage}L`);
      }
    } else {
      console.log(`default leveraged product not listed for ${one.baseSymbol}${one.leverage}L`);
    }
  }

  const updated = {
    ...data,
    leveragedTokenFactory: await leveragedFactory.getAddress(),
    leveragedProductRouter: await leveragedRouter.getAddress(),
  };
  await writeDeployments(filePath, updated);

  console.log("LeveragedTokenFactory deployed to:", await leveragedFactory.getAddress());
  console.log("LeveragedProductRouter deployed to:", await leveragedRouter.getAddress());
  console.log("Updated deployments:", filePath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
