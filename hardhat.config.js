import "dotenv/config";
import "hardhat-deploy";
import "@nomicfoundation/hardhat-ethers";
import "@openzeppelin/hardhat-upgrades";
import "@nomicfoundation/hardhat-verify";
import "@nomicfoundation/hardhat-chai-matchers";

export default {
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
      evmVersion: "cancun",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 1337,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://sepolia.drpc.org",
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY.startsWith("0x")
            ? process.env.PRIVATE_KEY
            : "0x" + process.env.PRIVATE_KEY]
        : [],
      chainId: 11155111,
    },
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "https://eth.drpc.org",
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY.startsWith("0x")
            ? process.env.PRIVATE_KEY
            : "0x" + process.env.PRIVATE_KEY]
        : [],
      chainId: 1,
    },
    // Custom network example for CCIP-Read testing
    custom: {
      url: process.env.CUSTOM_RPC_URL || "http://localhost:8545",
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY.startsWith("0x")
            ? process.env.PRIVATE_KEY
            : "0x" + process.env.PRIVATE_KEY]
        : [],
      chainId: process.env.CUSTOM_CHAIN_ID ? parseInt(process.env.CUSTOM_CHAIN_ID) : 1337,
    },
  },
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || "empty",
      mainnet: process.env.ETHERSCAN_API_KEY || "empty",
      custom: process.env.CUSTOM_ETHERSCAN_API_KEY || "empty",
    },
    customChains: [
      {
        network: "sepolia",
        chainId: 11155111,
        urls: {
          apiURL: "https://eth-sepolia.blockscout.com/api",
          browserURL: "https://eth-sepolia.blockscout.com",
        },
      },
      {
        network: "mainnet",
        chainId: 1,
        urls: {
          apiURL: "https://eth.blockscout.com/api",
          browserURL: "https://eth.blockscout.com",
        },
      },
      {
        network: "custom",
        chainId: process.env.CUSTOM_CHAIN_ID ? parseInt(process.env.CUSTOM_CHAIN_ID) : 1337,
        urls: {
          apiURL: process.env.CUSTOM_EXPLORER_API_URL || "http://localhost:4000/api",
          browserURL: process.env.CUSTOM_EXPLORER_URL || "http://localhost:4000",
        },
      },
    ],
  },
};