# Stage 2 — Listings & Factory

## Objective

Implement a factory to generate unique stock tokens and register them in a central registry.

## Deliverables

* `EquityToken.sol` — ERC-20 implementation for stocks
* `EquityTokenFactory.sol` — deploys new tokens, assigns MINTER_ROLE
* `ListingsRegistry.sol` — maps uppercase ticker symbol (A–Z, 0–9) → token address, prevents duplicates

## Functions

* `createEquityToken(symbol, name)` (admin only)
* `getListing(symbol)` returns token address
* Events: `StockListed(symbol, tokenAddr)`

## Tests

* Factory deploys unique token per symbol
* Registry accurately resolves addresses
* Access control enforced
* Rejects invalid symbols (must be A–Z or 0–9)

## Approval Criteria

* Verified on local network
* All tests pass and events emitted correctly




const signers = await ethers.getSigners();
const admin = signers[0];
const backendMinter = signers[2];

const Registry = await ethers.getContractFactory("ListingsRegistry");
const registry = await Registry.deploy(admin.address);
await registry.waitForDeployment();

const Factory = await ethers.getContractFactory("EquityTokenFactory");
const factory = await Factory.deploy(
  admin.address,
  await registry.getAddress(),
  backendMinter.address
);
await factory.waitForDeployment();

const listingRole = await registry.LISTING_ROLE();
await registry.grantRole(listingRole, await factory.getAddress());

await factory.createEquityToken("ACME1", "Acme Industries");

const tokenAddress = await registry.getListing("ACME1");
const token = await ethers.getContractAt("EquityToken", tokenAddress);

const metamaskWallet = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
await token.connect(backendMinter).mint(metamaskWallet, ethers.parseUnits("1000", 18));

await token.balanceOf(metamaskWallet);


<!-- 
export PRICE_FEED_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
export SYMBOL=AAPL
export FINNHUB_SYMBOL=AAPL
export FINNHUB_API_KEY=d4699t1r01qj716fvnmgd4699t1r01qj716fvnn0

npx hardhat run scripts/stage3/updatePriceFromFinnhub.js --network localhost



const feed = await ethers.getContractAt("PriceFeed", "0x5FbDB2315678afecb367f032d93F642f64180aa3");
await feed.getPrice("AAPL");
await feed.isFresh("AAPL");

 -->