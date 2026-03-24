/**
 * Check onchain address and ethers v6 resolution for an ENS name.
 * Uses ethers v6 only (no Hardhat), so resolveName() works.
 *
 * Run: NAME=lime.eth RESOLVER=0x... node scripts/check-resolver-addr.js
 * Or:  NAME=lime.eth RESOLVER=0x... RPC_URL=https://sepolia.drpc.org node scripts/check-resolver-addr.js
 */
import { ethers } from "ethers";

const RESOLVER_ABI = [
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes memory)",
];

async function main() {
  const name = process.env.NAME || "lime.eth";
  const resolverAddress = process.env.RESOLVER;
  const rpcUrl = process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || "https://sepolia.drpc.org";

  if (!resolverAddress) {
    console.error("Usage: NAME=lime.eth RESOLVER=0x... [RPC_URL=...] node scripts/check-resolver-addr.js");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const node = ethers.namehash(name);

  console.log(`Name: ${name}`);
  console.log(`Node: ${node}`);
  console.log(`Resolver: ${resolverAddress}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log("");

  const resolver = new ethers.Contract(resolverAddress, RESOLVER_ABI, provider);

  const legacyAddr = await resolver["addr(bytes32)"](node);
  console.log("Onchain addr(node) (legacy ETH):", legacyAddr === ethers.ZeroAddress ? "(empty)" : legacyAddr);

  const multicoinAddr = await resolver["addr(bytes32,uint256)"](node, 60);
  const multicoinFormatted =
    multicoinAddr.length === 0 ? "(empty)" : "0x" + ethers.hexlify(multicoinAddr).slice(2).padStart(40, "0").slice(-40);
  console.log("Onchain addr(node, 60):", multicoinFormatted);

  if (legacyAddr === ethers.ZeroAddress && multicoinAddr.length === 0) {
    console.log("\nNo onchain address set for this node. Resolution will use offchain (gateway) data.");
  }

  console.log("");
  const net = await provider.getNetwork();
  console.log(`Network: ${net.name ?? "unknown"} (chainId: ${net.chainId})`);
  try {
    const resolved = await provider.resolveName(name);
    console.log('ethers v6 resolveName("' + name + '"):', resolved ?? "(null)");
  } catch (e) {
    console.log('ethers v6 resolveName("' + name + '"): failed —', e.shortMessage ?? e.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
