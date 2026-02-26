const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

async function deployMerkleDividendsFixture() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const alice = signers[1];
  const bob = signers[2];
  const carol = signers[3];

  const ttokenFactory = await ethers.getContractFactory("TToken");
  const ttoken = await ttokenFactory.deploy();
  await ttoken.waitForDeployment();

  const registryFactory = await ethers.getContractFactory("ListingsRegistry");
  const registry = await registryFactory.deploy(admin.address);
  await registry.waitForDeployment();

  const equityFactory = await ethers.getContractFactory("EquityToken");
  const equity = await equityFactory.deploy("Acme Equity", "ACME1", admin.address, admin.address);
  await equity.waitForDeployment();

  const equityAddress = await equity.getAddress();
  await registry.connect(admin).registerListing("ACME1", "Acme Equity", equityAddress);

  const merkleFactory = await ethers.getContractFactory("DividendsMerkle");
  const merkle = await merkleFactory.deploy(
    await ttoken.getAddress(),
    await registry.getAddress(),
    admin.address
  );
  await merkle.waitForDeployment();

  const minterRole = await ttoken.MINTER_ROLE();
  await ttoken.connect(admin).grantRole(minterRole, await merkle.getAddress());

  return { admin, alice, bob, carol, ttoken, registry, equity, merkle };
}

function encodeLeaf(epochId, tokenAddress, account, amountWei, leafIndex) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "address", "uint256", "uint256"],
    [BigInt(epochId), tokenAddress, account, BigInt(amountWei), BigInt(leafIndex)]
  );
  return ethers.keccak256(encoded);
}

function hashPair(left, right) {
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [left, right]));
}

function buildLevels(leafHashes) {
  const levels = [];
  levels.push(leafHashes.slice());
  let current = leafHashes.slice();
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      let right = left;
      if (i + 1 < current.length) {
        right = current[i + 1];
      }
      const parent = hashPair(left, right);
      next.push(parent);
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

function rootFromLeaves(leafHashes) {
  const levels = buildLevels(leafHashes);
  return levels[levels.length - 1][0];
}

function proofForIndex(leafHashes, leafIndex) {
  const levels = buildLevels(leafHashes);
  const proof = [];
  let index = leafIndex;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const rows = levels[level];
    let siblingIndex = index + 1;
    if (index % 2 === 1) {
      siblingIndex = index - 1;
    }
    if (siblingIndex >= rows.length) {
      siblingIndex = index;
    }
    proof.push(rows[siblingIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

const describeLocal = network.name === "hardhat" ? describe : describe.skip;

describeLocal("DividendsMerkle", function () {
  it("claims with valid proof and tracks accounting", async function () {
    const fixture = await loadFixture(deployMerkleDividendsFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const bob = fixture.bob;
    const ttoken = fixture.ttoken;
    const equity = fixture.equity;
    const merkle = fixture.merkle;

    const epochId = 1;
    const tokenAddress = await equity.getAddress();
    const aliceAmount = 2n * 10n ** 18n;
    const bobAmount = 3n * 10n ** 18n;

    const leaves = [
      encodeLeaf(epochId, tokenAddress, alice.address, aliceAmount, 0),
      encodeLeaf(epochId, tokenAddress, bob.address, bobAmount, 1),
    ];
    const root = rootFromLeaves(leaves);
    const total = aliceAmount + bobAmount;

    await merkle.connect(admin).declareMerkleDividend(
      tokenAddress,
      root,
      total,
      ethers.ZeroHash,
      "ipfs://claims"
    );

    const aliceProof = proofForIndex(leaves, 0);
    await merkle.connect(alice).claim(epochId, alice.address, aliceAmount, 0, aliceProof);
    expect(await ttoken.balanceOf(alice.address)).to.equal(aliceAmount);

    const epoch = await merkle.getEpoch(epochId);
    expect(epoch.totalClaimedWei).to.equal(aliceAmount);
  });

  it("prevents double claim for same leaf index", async function () {
    const fixture = await loadFixture(deployMerkleDividendsFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const equity = fixture.equity;
    const merkle = fixture.merkle;

    const epochId = 1;
    const tokenAddress = await equity.getAddress();
    const amount = 1n * 10n ** 18n;
    const leaves = [encodeLeaf(epochId, tokenAddress, alice.address, amount, 0)];
    const root = rootFromLeaves(leaves);

    await merkle.connect(admin).declareMerkleDividend(
      tokenAddress,
      root,
      amount,
      ethers.ZeroHash,
      ""
    );

    const proof = proofForIndex(leaves, 0);
    await merkle.connect(alice).claim(epochId, alice.address, amount, 0, proof);
    await expect(merkle.connect(alice).claim(epochId, alice.address, amount, 0, proof))
      .to.be.revertedWith("dividendsmerkle: already claimed");
  });

  it("rejects wrong amount and wrong index", async function () {
    const fixture = await loadFixture(deployMerkleDividendsFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const bob = fixture.bob;
    const equity = fixture.equity;
    const merkle = fixture.merkle;

    const epochId = 1;
    const tokenAddress = await equity.getAddress();
    const aliceAmount = 2n * 10n ** 18n;
    const bobAmount = 1n * 10n ** 18n;
    const leaves = [
      encodeLeaf(epochId, tokenAddress, alice.address, aliceAmount, 0),
      encodeLeaf(epochId, tokenAddress, bob.address, bobAmount, 1),
    ];
    const root = rootFromLeaves(leaves);

    await merkle.connect(admin).declareMerkleDividend(
      tokenAddress,
      root,
      aliceAmount + bobAmount,
      ethers.ZeroHash,
      ""
    );

    const aliceProof = proofForIndex(leaves, 0);
    await expect(merkle.connect(alice).claim(epochId, alice.address, 5n * 10n ** 18n, 0, aliceProof))
      .to.be.revertedWith("dividendsmerkle: invalid proof");

    await expect(merkle.connect(alice).claim(epochId, alice.address, aliceAmount, 1, aliceProof))
      .to.be.revertedWith("dividendsmerkle: invalid proof");
  });

  it("rejects wrong epoch or wrong token usage", async function () {
    const fixture = await loadFixture(deployMerkleDividendsFixture);
    const admin = fixture.admin;
    const alice = fixture.alice;
    const equity = fixture.equity;
    const merkle = fixture.merkle;

    const tokenAddress = await equity.getAddress();
    const amount = 1n * 10n ** 18n;
    const leaves = [encodeLeaf(1, tokenAddress, alice.address, amount, 0)];
    const root = rootFromLeaves(leaves);

    await merkle.connect(admin).declareMerkleDividend(
      tokenAddress,
      root,
      amount,
      ethers.ZeroHash,
      ""
    );

    const proof = proofForIndex(leaves, 0);
    await expect(merkle.connect(alice).claim(2, alice.address, amount, 0, proof))
      .to.be.revertedWith("dividendsmerkle: epoch not found");
  });
});
