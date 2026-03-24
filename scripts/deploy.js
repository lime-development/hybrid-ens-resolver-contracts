import "dotenv/config";
import hre from "hardhat";
const { ethers, upgrades } = hre;
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // Detect network from Hardhat config
  const network = hre.network.name;
  // Get chainId from Hardhat config (more reliable than querying provider)
  let chainId = hre.network.config.chainId;
  
  // Try to get chainId from provider if not in config (with error handling)
  if (!chainId) {
    try {
      const networkInfo = await ethers.provider.getNetwork();
      // ethers v6 returns BigInt; Number() for JSON.stringify compatibility (L-4)
      chainId = Number(networkInfo.chainId);
    } catch (error) {
      console.warn("⚠️  Could not detect chainId from provider, using config value");
    }
  }

  // L-1: Fail early if chainId is undefined — prevents writing invalid deployment JSON
  if (chainId === undefined || chainId === null) {
    throw new Error(
      `Cannot determine chainId for network "${network}". ` +
      `Add chainId to hardhat.config.js: networks: { ${network}: { chainId: ... } }`
    );
  }

  // Ensure numeric for JSON serialization (config may give number or BigInt)
  chainId = Number(chainId);

  console.log(`Starting deployment to ${network}...`);
  console.log(`Network: ${network}, Chain ID: ${chainId}`);

  // Get deployer account
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No signers found. Please check your hardhat.config.js and ensure PRIVATE_KEY is correctly configured.\n" +
      "PRIVATE_KEY is " + (process.env.PRIVATE_KEY ? "set" : "not set") + "."
    );
  }
  const deployer = signers[0];
  console.log("Deploying contracts with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error(
      `Account balance is zero. Please fund your account with ${network} ETH.`
    );
  }

  // Warn if balance is low (especially for mainnet)
  const balanceNum = parseFloat(ethers.formatEther(balance));
  if (network === "mainnet" && balanceNum < 0.01) {
    console.warn("⚠️  WARNING: Low balance detected. Make sure you have enough ETH for gas fees.");
  }

  // Get configuration from environment variables (GATEWAY_URLS = comma-separated, or GATEWAY_URL = single URL)
  let gatewayURLs = [];
  if (process.env.GATEWAY_URLS) {
    gatewayURLs = process.env.GATEWAY_URLS.split(",").map(u => u.trim()).filter(u => u.length > 0);
  }
  if (gatewayURLs.length === 0 && process.env.GATEWAY_URL) {
    gatewayURLs = [process.env.GATEWAY_URL.trim()];
  }
  if (gatewayURLs.length === 0) {
    throw new Error(
      "GATEWAY_URL or GATEWAY_URLS is not set in environment variables.\n" +
      "Please create a .env file in the contracts directory with:\n" +
      "GATEWAY_URL=https://your-gateway-url.com\n" +
      "or GATEWAY_URLS=https://gateway1.com,https://gateway2.com"
    );
  }
  // Contract enforces MAX_URLS = 5
  const MAX_URLS = 5;
  if (gatewayURLs.length > MAX_URLS) {
    throw new Error(
      `Too many gateway URLs (${gatewayURLs.length}). Contract allows at most ${MAX_URLS}.`
    );
  }

  // L-4: EIP-3668 clients typically require HTTPS — warn if URL does not use it
  for (const url of gatewayURLs) {
    if (!url.startsWith("https://")) {
      console.warn(`⚠️  WARNING: URL "${url}" does not use HTTPS. EIP-3668 clients may reject it.`);
    }
  }

  // CCIP signer addresses: backend keys that sign gateway responses.
  // Backend private key is generated and stored on the backend server only — never in deploy env.
  if (!process.env.SIGNER_ADDRESSES) {
    throw new Error(
      "SIGNER_ADDRESSES must be set (comma-separated Ethereum addresses).\n" +
      "Example: SIGNER_ADDRESSES=0xYourBackendSignerAddress1,0xYourBackendSignerAddress2"
    );
  }
  let signerAddresses = process.env.SIGNER_ADDRESSES
    .split(",")
    .map(addr => addr.trim())
    .filter(addr => addr.length > 0);
  for (const addr of signerAddresses) {
    if (!ethers.isAddress(addr)) {
      throw new Error(`Invalid signer address: ${addr}`);
    }
  }
  // Deduplicate (case-insensitive)
  const seenSigners = new Set();
  signerAddresses = signerAddresses.filter(addr => {
    const key = addr.toLowerCase();
    if (seenSigners.has(key)) return false;
    seenSigners.add(key);
    return true;
  });
  console.log(`  CCIP signers: ${signerAddresses.length} address(es) from SIGNER_ADDRESSES`);

  // setAddr signers: cold keys (multisig/hardware) for onchain setAddr. Must be set explicitly.
  if (process.env.SETADDR_SIGNER_ADDRESSES === undefined) {
    throw new Error(
      "SETADDR_SIGNER_ADDRESSES must be set (comma-separated Ethereum addresses, or empty for CCIP-only).\n" +
      "Example: SETADDR_SIGNER_ADDRESSES=0xColdKey1,0xColdKey2\n" +
      "To disable onchain setAddr: SETADDR_SIGNER_ADDRESSES="
    );
  }
  let setAddrSignerAddresses;
  if (process.env.SETADDR_SIGNER_ADDRESSES.trim() === "") {
    setAddrSignerAddresses = [];
    console.log("  setAddr signers: none (CCIP-only mode)");
  } else {
    const raw = process.env.SETADDR_SIGNER_ADDRESSES
      .split(",")
      .map(addr => addr.trim())
      .filter(addr => addr.length > 0);
    for (const addr of raw) {
      if (!ethers.isAddress(addr)) throw new Error(`Invalid SETADDR_SIGNER_ADDRESSES entry: ${addr}`);
    }
    const seen = new Set();
    setAddrSignerAddresses = raw.filter(addr => {
      const key = addr.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log("  setAddr signers:", setAddrSignerAddresses.length, "address(es)");
  }

  // L-3: Warn if CCIP (hot) and setAddr (cold) keys overlap — recommend different keys
  const ccipSet = new Set(signerAddresses.map((a) => a.toLowerCase()));
  const overlapping = setAddrSignerAddresses.filter((addr) => ccipSet.has(addr.toLowerCase()));
  if (overlapping.length > 0) {
    console.warn("⚠️  WARNING: The following address(es) appear in both SIGNER_ADDRESSES and SETADDR_SIGNER_ADDRESSES:", overlapping.join(", "));
    console.warn("   CCIP (hot) and setAddr (cold) keys should be different.");
  }

  // Contract owner: must be set explicitly (e.g. Gnosis Safe or multisig).
  if (!process.env.OWNER_ADDRESS) {
    throw new Error(
      "OWNER_ADDRESS must be set (Ethereum address of the contract owner, e.g. Gnosis Safe)."
    );
  }
  const ownerAddress = process.env.OWNER_ADDRESS.trim();
  if (!ethers.isAddress(ownerAddress)) {
    throw new Error(`Invalid OWNER_ADDRESS: ${ownerAddress}`);
  }

  // L-2: Warn if owner is the deployer (hot key) — recommend multisig/Gnosis Safe
  if (ownerAddress.toLowerCase() === deployer.address.toLowerCase()) {
    console.warn("⚠️  WARNING: OWNER_ADDRESS equals deployer address.");
    console.warn("   Owner should be a Gnosis Safe or multisig, not a hot key.");
  }

  console.log("\nConfiguration:");
  console.log("  Gateway URLs:", gatewayURLs);
  console.log("  CCIP signers:", signerAddresses);
  console.log("  setAddr signers:", setAddrSignerAddresses);
  console.log("  owner:", ownerAddress);

  // Deploy UUPS proxy atomically (implementation + proxy + initialize in one tx via OZ plugin)
  console.log("\nDeploying HybridResolver (UUPS proxy)...");
  const HybridResolver = await ethers.getContractFactory("HybridResolver");
  const proxy = await upgrades.deployProxy(
    HybridResolver,
    [gatewayURLs, signerAddresses, setAddrSignerAddresses, ownerAddress],
    { kind: "uups" }
  );
  await proxy.waitForDeployment();
  const resolverAddress = await proxy.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(resolverAddress);
  console.log("✓ HybridResolver proxy (use this address in ENS) at:", resolverAddress);
  console.log("  Implementation at:", implementationAddress);

  // Save deployment info
  const deploymentInfo = {
    network: network,
    chainId: chainId,
    contract: "HybridResolver",
    address: resolverAddress,
    implementation: implementationAddress,
    gatewayURLs: gatewayURLs,
    ccipSigners: signerAddresses,
    setAddrSigners: setAddrSignerAddresses,
    owner: ownerAddress,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
  };

  const deploymentPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  const deploymentDir = path.dirname(deploymentPath);
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  console.log("\n✓ Deployment info saved to:", deploymentPath);

  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUCCESSFUL");
  console.log("=".repeat(60));
  console.log("\nDeployment info:");
  console.log(JSON.stringify(deploymentInfo, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
