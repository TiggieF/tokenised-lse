const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Helper constants matching the Solidity definitions so that the assertions use
 * precisely the same values as the contract.  BigInt is used to maintain full
 * precision when dealing with the large cap (3 × 10^50).
 */
const MAX_SUPPLY = 3n * 10n ** 50n;
const AIRDROP_AMOUNT = ethers.parseEther("1000000");

/**
 * Deploys a new TToken instance and returns common test fixtures.  Using
 * `loadFixture` in the tests ensures each case starts from a clean chain
 * snapshot while keeping the suite performant.
 */
async function deployTTokenFixture() {
  const [admin, otherUser, anotherUser] = await ethers.getSigners();
  const TToken = await ethers.getContractFactory("TToken");
  const token = await TToken.deploy();
  await token.waitForDeployment();

  return { token, admin, otherUser, anotherUser };
}

describe("Stage 1 — TToken token", function () {
  describe("Deployment", function () {
    it("assigns deployer as admin and minter", async function () {
      const { token, admin } = await loadFixture(deployTTokenFixture);

      const adminRole = await token.DEFAULT_ADMIN_ROLE();
      const minterRole = await token.MINTER_ROLE();

      expect(await token.hasRole(adminRole, admin.address)).to.equal(true);
      expect(await token.hasRole(minterRole, admin.address)).to.equal(true);
    });

    it("starts with zero supply", async function () {
      const { token } = await loadFixture(deployTTokenFixture);
      expect(await token.totalSupply()).to.equal(0);
    });
  });

  describe("Minting controls", function () {
    it("allows minter to mint within the cap", async function () {
      const { token, admin, otherUser } = await loadFixture(deployTTokenFixture);
      const amount = ethers.parseEther("2500000");

      await expect(token.connect(admin).mint(otherUser.address, amount))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, otherUser.address, amount);

      expect(await token.totalSupply()).to.equal(amount);
      expect(await token.balanceOf(otherUser.address)).to.equal(amount);
    });

    it("reverts when non-minter attempts to mint", async function () {
      const { token, otherUser } = await loadFixture(deployTTokenFixture);
      const amount = ethers.parseEther("1");

      await expect(token.connect(otherUser).mint(otherUser.address, amount))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(otherUser.address, await token.MINTER_ROLE());
    });

    it("enforces the global cap", async function () {
      const { token, admin } = await loadFixture(deployTTokenFixture);
      const nearCap = MAX_SUPPLY - AIRDROP_AMOUNT + 1n;

      await token.connect(admin).mint(admin.address, nearCap);

      await expect(token.connect(admin).mint(admin.address, AIRDROP_AMOUNT))
        .to.be.revertedWith("ttoken: cap exceeded");
    });
  });

  describe("Airdrop", function () {
    it("mints the defined airdrop amount once per wallet", async function () {
      const { token, otherUser } = await loadFixture(deployTTokenFixture);

      await expect(token.connect(otherUser).airdropOnce())
        .to.emit(token, "AirdropClaimed")
        .withArgs(otherUser.address, AIRDROP_AMOUNT);

      expect(await token.balanceOf(otherUser.address)).to.equal(AIRDROP_AMOUNT);
      expect(await token.totalSupply()).to.equal(AIRDROP_AMOUNT);

      await expect(token.connect(otherUser).airdropOnce())
        .to.be.revertedWith("ttoken: airdrop already claimed");
    });

    it("prevents airdrop when cap would be exceeded", async function () {
      const { token, admin, otherUser } = await loadFixture(deployTTokenFixture);
      const nearCap = MAX_SUPPLY - AIRDROP_AMOUNT + 1n;

      await token.connect(admin).mint(admin.address, nearCap);

      await expect(token.connect(otherUser).airdropOnce())
        .to.be.revertedWith("ttoken: cap exceeded");
    });

    it("exposes helper to check claim status", async function () {
      const { token, otherUser } = await loadFixture(deployTTokenFixture);
      expect(await token.hasClaimedAirdrop(otherUser.address)).to.equal(false);

      await token.connect(otherUser).airdropOnce();
      expect(await token.hasClaimedAirdrop(otherUser.address)).to.equal(true);
    });
  });

  describe("Standard ERC-20 flows", function () {
    it("supports transfer and allowances", async function () {
      const { token, admin, otherUser, anotherUser } = await loadFixture(deployTTokenFixture);

      const mintAmount = ethers.parseEther("10");
      await token.connect(admin).mint(admin.address, mintAmount);

      await expect(token.connect(admin).transfer(otherUser.address, mintAmount))
        .to.emit(token, "Transfer")
        .withArgs(admin.address, otherUser.address, mintAmount);

      await expect(token.connect(otherUser).approve(anotherUser.address, mintAmount))
        .to.emit(token, "Approval")
        .withArgs(otherUser.address, anotherUser.address, mintAmount);

      await expect(token.connect(anotherUser).transferFrom(otherUser.address, anotherUser.address, mintAmount))
        .to.emit(token, "Transfer")
        .withArgs(otherUser.address, anotherUser.address, mintAmount);

      expect(await token.balanceOf(anotherUser.address)).to.equal(mintAmount);
      expect(await token.allowance(otherUser.address, anotherUser.address)).to.equal(0);
    });
  });
});
