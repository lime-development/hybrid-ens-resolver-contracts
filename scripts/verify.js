import "dotenv/config";
import hre from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const explorerUrl = (networkName, address) =>
  networkName === "mainnet"
    ? `https://eth.blockscout.com/address/${address}`
    : `https://eth-sepolia.blockscout.com/address/${address}`;

async function verifyWithRetry(options) {
  try {
    await hre.run("verify:verify", options);
    return { ok: true };
  } catch (error) {
    if (error.message.includes("Already Verified") || error.message.includes("already verified")) {
      return { ok: true, alreadyVerified: true };
    }
    return { ok: false, error };
  }
}

async function main() {
  // Get network from command line arguments or environment
  const network = process.argv.includes("--network")
    ? process.argv[process.argv.indexOf("--network") + 1]
    : hre.network.name;

  const networkName = network || hre.network.name;

  console.log(`Verifying contract on Blockscout (network: ${networkName})...`);

  // Load deployment info for the target network
  const deploymentPath = path.join(__dirname, "..", "deployments", `${networkName}.json`);

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Deployment info not found at ${deploymentPath}. Please deploy the contract first.`);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const contractAddress = deploymentInfo.address;
  const implementationAddress = deploymentInfo.implementation;
  const gatewayURLs = deploymentInfo.gatewayURLs ?? (deploymentInfo.gatewayURL ? [deploymentInfo.gatewayURL] : []);
  const ccipSigners = deploymentInfo.ccipSigners ?? deploymentInfo.signers ?? [];
  const setAddrSigners = deploymentInfo.setAddrSigners ?? deploymentInfo.signers ?? [];
  const owner = deploymentInfo.owner;

  console.log("Contract address (proxy):", contractAddress);
  if (implementationAddress) console.log("Implementation address:", implementationAddress);
  console.log("Gateway URLs:", gatewayURLs);
  console.log("CCIP signers:", ccipSigners);
  console.log("setAddr signers:", setAddrSigners);
  console.log("Owner:", owner);

  const errors = [];

  // 1. Verify implementation (HybridResolver has no constructor args; only initializer is used by the proxy)
  if (implementationAddress) {
    console.log("\nVerifying implementation (HybridResolver, no constructor args)...");
    const result = await verifyWithRetry({
      address: implementationAddress,
      constructorArguments: [],
    });
    if (result.ok) {
      console.log(result.alreadyVerified ? "  ✓ Implementation already verified." : "  ✓ Implementation verified.");
    } else {
      errors.push(`Implementation: ${result.error.message}`);
    }
  }

  // 2. Verify proxy: ERC1967Proxy(implementation, initializerCalldata). Best-effort (proxy may already be verified).
  const implAddress = implementationAddress || (await hre.upgrades.erc1967.getImplementationAddress(contractAddress));
  const { ethers } = hre;
  const HybridResolver = await ethers.getContractFactory("HybridResolver");
  const initializerData = HybridResolver.interface.encodeFunctionData("initialize", [
    gatewayURLs,
    ccipSigners,
    setAddrSigners,
    owner,
  ]);
  const proxyConstructorArgs = [implAddress, initializerData];

  console.log("\nVerifying proxy (ERC1967Proxy with implementation + initializer data)...");
  const proxyResult = await verifyWithRetry({
    address: contractAddress,
    constructorArguments: proxyConstructorArgs,
    contract: "node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  });
  if (proxyResult.ok) {
    console.log(proxyResult.alreadyVerified ? "  ✓ Proxy already verified." : "  ✓ Proxy verified.");
  } else {
    // Proxy is often already verified or explorer links it; do not fail the run
    console.warn("  ⚠ Proxy verification skipped or failed (proxy may already be verified):", proxyResult.error.message);
  }

  if (errors.length > 0) {
    console.error("\n✗ Verification completed with errors:\n");
    errors.forEach((msg, i) => console.error(`Error ${i + 1}: ${msg}`));
    throw new Error("Verification completed with the following errors.\n" + errors.join("\n"));
  }

  console.log("\n✓ Verification completed successfully.");
  console.log("Proxy:", explorerUrl(networkName, contractAddress));
  if (implementationAddress) console.log("Implementation:", explorerUrl(networkName, implementationAddress));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

