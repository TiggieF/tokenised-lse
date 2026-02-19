const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

async function deployListingsFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const otherUser = signers[1];
  const minter = signers[2];

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const factoryFactory = await ethers.getContractFactory("EquityTokenFactory");
  const factory = await factoryFactory.deploy(
    admin.address,
    await registry.getAddress(),
    minter.address
  );
  await factory.waitForDeployment();

  const listingRole = await registry.LISTING_ROLE();
  const factoryAddress = await factory.getAddress();
  await registry.connect(admin).grantRole(listingRole, factoryAddress);

  return { admin, otherUser, minter, registry, factory };
}

describe("Listings & Factory", function () {
  it("deploys and registers a new equity token per symbol", async function () {
    const fixture = await loadFixture(deployListingsFixture);
    const admin = fixture.admin;
    const minter = fixture.minter;
    const registry = fixture.registry;
    const factory = fixture.factory;

    const symbol = "ACME";
    const name = "Acme Industries";

    const tx = await factory.connect(admin).createEquityToken(symbol, name);
    await tx.wait();

    const tokenAddress = await registry.getListing(symbol);
    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);

    await expect(tx)
      .to.emit(registry, "StockListed")
      .withArgs(symbol, tokenAddress);

    const token = await ethers.getContractAt("EquityToken", tokenAddress);
    const tokenName = await token.name();
    const tokenSymbol = await token.symbol();

    expect(tokenName).to.equal(name);
    expect(tokenSymbol).to.equal(symbol);

    const adminRole = await token.DEFAULT_ADMIN_ROLE();
    const minterRole = await token.MINTER_ROLE();

    const hasAdminRole = await token.hasRole(adminRole, admin.address);
    const hasMinterRole = await token.hasRole(minterRole, minter.address);

    expect(hasAdminRole).to.equal(true);
    expect(hasMinterRole).to.equal(true);
  });

  it("prevents duplicate symbols", async function () {
    const fixture = await loadFixture(deployListingsFixture);
    const admin = fixture.admin;
    const factory = fixture.factory;

    await factory.connect(admin).createEquityToken("ACME", "Acme Industries");

    await expect(factory.connect(admin).createEquityToken("ACME", "Other Name"))
      .to.be.revertedWith("listingsregistry: symbol already listed");
  });

  it("registry resolves addresses", async function () {
    const fixture = await loadFixture(deployListingsFixture);
    const admin = fixture.admin;
    const registry = fixture.registry;
    const factory = fixture.factory;

    await factory.connect(admin).createEquityToken("NVDA", "NVIDIA Corp");
    const tokenAddress = await registry.getListing("NVDA");

    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
  });

  it("returns full listing info and listed state", async function () {
    const fixture = await loadFixture(deployListingsFixture);
    const admin = fixture.admin;
    const registry = fixture.registry;
    const factory = fixture.factory;

    const symbol = "NVDA";
    const name = "NVIDIA Corp";

    await factory.connect(admin).createEquityToken(symbol, name);

    const listing = await registry.getListingFull(symbol);
    const tokenAddress = listing[0];
    const storedSymbol = listing[1];
    const storedName = listing[2];

    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
    expect(storedSymbol).to.equal(symbol);
    expect(storedName).to.equal(name);

    const isListed = await registry.isListed(symbol);
    expect(isListed).to.equal(true);

    const missing = await registry.getListingFull("MISSING1");
    expect(missing[0]).to.equal(ethers.ZeroAddress);
    expect(missing[1]).to.equal("");
    expect(missing[2]).to.equal("");

    const missingListed = await registry.isListed("MISSING1");
    expect(missingListed).to.equal(false);
  });

  it("enforces access control", async function () {
    const fixture = await loadFixture(deployListingsFixture);
    const admin = fixture.admin;
    const otherUser = fixture.otherUser;
    const registry = fixture.registry;
    const factory = fixture.factory;

    const adminRole = await factory.DEFAULT_ADMIN_ROLE();
    await expect(factory.connect(otherUser).createEquityToken("ACME", "Acme"))
      .to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount")
      .withArgs(otherUser.address, adminRole);

    const listingRole = await registry.LISTING_ROLE();
    await expect(registry.connect(otherUser).registerListing("SYM", "Name", admin.address))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
      .withArgs(otherUser.address, listingRole);
  });

  it("rejects symbols with lowercase letters", async function () {
    const fixture = await loadFixture(deployListingsFixture);
    const admin = fixture.admin;
    const factory = fixture.factory;

    await expect(factory.connect(admin).createEquityToken("Acme", "Acme Corp"))
      .to.be.revertedWith("listingsregistry: symbol must be upper-case or 0-9");
  });

  it("allows digits in symbols", async function () {
    const fixture = await loadFixture(deployListingsFixture);
    const admin = fixture.admin;
    const registry = fixture.registry;
    const factory = fixture.factory;

    await factory.connect(admin).createEquityToken("ACME1", "Acme One");
    const tokenAddress = await registry.getListing("ACME1");

    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
  });
});
