import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import * as dotenv from "dotenv";
import * as path from "path";

// Load the repository-root .env (never committed).
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const sepoliaRpc = process.env.SEPOLIA_RPC_URL ?? "";
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    ...(sepoliaRpc && deployerKey
      ? {
          sepolia: {
            url: sepoliaRpc,
            chainId: 11155111,
            accounts: [deployerKey],
          },
        }
      : {}),
  },
};

export default config;
