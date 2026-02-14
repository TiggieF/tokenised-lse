require("@nomicfoundation/hardhat-toolbox");

const config = {
  solidity: "0.8.20",
  networks: {
    hardhat: {
      chainId: 31338,
    },
  },
  mocha: {
    timeout: 200000,
  },
};

module.exports = config;
