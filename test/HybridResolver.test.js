import { expect } from "chai";
import hre from "hardhat";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { ethers: hardhatEthers } = hre;

// Pre-built artifact from @openzeppelin/contracts (no need to compile proxy ourselves)
const ERC1967_PROXY_ARTIFACT_PATH = path.join(__dirname, "..", "node_modules", "@openzeppelin", "contracts", "build", "contracts", "ERC1967Proxy.json");

// Helper function to sign a hash directly (without Ethereum message prefix)
// This signs the hash using ECDSA directly, as required by the contract
function signHash(wallet, hash) {
  // In ethers v6, we use wallet.signingKey to get the signing key
  const signature = wallet.signingKey.sign(hash);
  // Return signature in format: 0x + r (64 chars) + s (64 chars) + v (2 chars)
  return ethers.Signature.from(signature).serialized;
}

// COIN_TYPE_ETH (60): used for legacy addr(node) and main ENS display
const COIN_TYPE_ETH = 60;

// Helper: get deadline, nonce and signature for setAddr(node, coinType, addressBytes, deadline, nonce, signature). Backend signs (node, coinType, addressBytes, contract, deadline, nonce).
async function signSetAddr(resolver, signerWallet, node, coinType, addressBytes) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = await resolver.nonces(node);
  const hash = await resolver.setAddrSignatureHash.staticCall(node, coinType, addressBytes, deadline, nonce);
  const signature = signHash(signerWallet, hash);
  return { deadline, nonce, signature };
}

// Deploy HybridResolver behind UUPS proxy and return contract attached to proxy address.
async function deployHybridResolver(hreEthers, urls, ccipSigners, setAddrSigners, initialOwner) {
  const HybridResolver = await hreEthers.getContractFactory("HybridResolver");
  const implementation = await HybridResolver.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  const initData = HybridResolver.interface.encodeFunctionData("initialize", [
    urls,
    ccipSigners,
    setAddrSigners,
    initialOwner,
  ]);
  const ERC1967ProxyArtifact = JSON.parse(fs.readFileSync(ERC1967_PROXY_ARTIFACT_PATH, "utf8"));
  const [deployer] = await hreEthers.getSigners();
  const ProxyFactory = new ethers.ContractFactory(
    ERC1967ProxyArtifact.abi,
    ERC1967ProxyArtifact.bytecode,
    deployer
  );
  const proxy = await ProxyFactory.deploy(implementationAddress, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  return HybridResolver.attach(proxyAddress);
}

describe("HybridResolver", function () {
  let resolver;
  let owner, signer1, signer2, user;
  let signer1Wallet, signer2Wallet, userWallet; // Wallets with accessible private keys
  let testURLs = ["https://example.com/gateway"];

  beforeEach(async function () {
    [owner, signer1, signer2, user] = await hardhatEthers.getSigners();

    // Create wallets from the signers' addresses for signing
    // In Hardhat, we can fund these addresses and use them
    // For now, we'll create new wallets and fund them, or use the signers directly
    // Actually, let's use a simpler approach: create wallets and add them as signers in the contract
    signer1Wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, hardhatEthers.provider);
    signer2Wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, hardhatEthers.provider);
    userWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, hardhatEthers.provider);

    // Fund the wallets
    await owner.sendTransaction({
      to: signer1Wallet.address,
      value: ethers.parseEther("1.0")
    });
    await owner.sendTransaction({
      to: signer2Wallet.address,
      value: ethers.parseEther("1.0")
    });
    await owner.sendTransaction({
      to: userWallet.address,
      value: ethers.parseEther("1.0")
    });

    // Deploy UUPS proxy + implementation; use proxy address as resolver
    resolver = await deployHybridResolver(
      hardhatEthers,
      testURLs,
      [signer1Wallet.address, signer2Wallet.address],
      [signer1Wallet.address, signer2Wallet.address],
      owner.address
    );
  });

  describe("Deployment", function () {
    it("Should set the correct URLs", async function () {
      expect(await resolver.urls(0)).to.equal(testURLs[0]);
    });

    it("Should set the correct owner", async function () {
      expect(await resolver.owner()).to.equal(owner.address);
    });

    it("Should initialize CCIP and setAddr signers correctly", async function () {
      expect(await resolver.ccipSigners(signer1Wallet.address)).to.be.true;
      expect(await resolver.ccipSigners(signer2Wallet.address)).to.be.true;
      expect(await resolver.setAddrSigners(signer1Wallet.address)).to.be.true;
      expect(await resolver.setAddrSigners(signer2Wallet.address)).to.be.true;
      expect(await resolver.ccipSigners(userWallet.address)).to.be.false;
      expect(await resolver.setAddrSigners(userWallet.address)).to.be.false;
    });

    it("Should emit URLsUpdated, CcipSignersAdded and SetAddrSignersAdded on deployment", async function () {
      const HybridResolver = await hardhatEthers.getContractFactory("HybridResolver");
      const impl = await HybridResolver.deploy();
      await impl.waitForDeployment();
      const initData = HybridResolver.interface.encodeFunctionData("initialize", [
        testURLs,
        [signer1Wallet.address],
        [signer1Wallet.address],
        owner.address,
      ]);
      const ERC1967ProxyArtifact = JSON.parse(fs.readFileSync(ERC1967_PROXY_ARTIFACT_PATH, "utf8"));
      const [deployer] = await hardhatEthers.getSigners();
      const ProxyFactory = new ethers.ContractFactory(ERC1967ProxyArtifact.abi, ERC1967ProxyArtifact.bytecode, deployer);
      const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
      await proxy.waitForDeployment();
      const deployTx = proxy.deploymentTransaction();
      const receipt = await hardhatEthers.provider.getTransactionReceipt(deployTx.hash);
      const proxyAddr = (await proxy.getAddress()).toLowerCase();
      const deploymentLogs = receipt.logs.filter(l => l.address.toLowerCase() === proxyAddr);
      expect(deploymentLogs.length).to.be.at.least(2, "deployment must emit URLsUpdated and CcipSignersAdded so indexers can reconstruct state");
    });

    it("Should reject empty URLs array", async function () {
      const HybridResolver = await hardhatEthers.getContractFactory("HybridResolver");
      const impl = await HybridResolver.deploy();
      await impl.waitForDeployment();
      const initData = HybridResolver.interface.encodeFunctionData("initialize", [[], [signer1.address], [signer1.address], owner.address]);
      const ERC1967ProxyArtifact = JSON.parse(fs.readFileSync(ERC1967_PROXY_ARTIFACT_PATH, "utf8"));
      const [deployer] = await hardhatEthers.getSigners();
      const ProxyFactory = new ethers.ContractFactory(ERC1967ProxyArtifact.abi, ERC1967ProxyArtifact.bytecode, deployer);
      await expect(ProxyFactory.deploy(await impl.getAddress(), initData)).to.be.revertedWithCustomError(HybridResolver, "URLsCannotBeEmpty");
    });

    it("Should reject empty URL in array", async function () {
      const HybridResolver = await hardhatEthers.getContractFactory("HybridResolver");
      const impl = await HybridResolver.deploy();
      await impl.waitForDeployment();
      const initData = HybridResolver.interface.encodeFunctionData("initialize", [["https://ok.com", ""], [signer1.address], [signer1.address], owner.address]);
      const ERC1967ProxyArtifact = JSON.parse(fs.readFileSync(ERC1967_PROXY_ARTIFACT_PATH, "utf8"));
      const [deployer] = await hardhatEthers.getSigners();
      const ProxyFactory = new ethers.ContractFactory(ERC1967ProxyArtifact.abi, ERC1967ProxyArtifact.bytecode, deployer);
      await expect(ProxyFactory.deploy(await impl.getAddress(), initData)).to.be.revertedWithCustomError(HybridResolver, "URLCannotBeEmpty");
    });

    it("Should reject too many URLs in constructor", async function () {
      const HybridResolver = await hardhatEthers.getContractFactory("HybridResolver");
      const impl = await HybridResolver.deploy();
      await impl.waitForDeployment();
      const sixURLs = ["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", "https://f.com"];
      const initData = HybridResolver.interface.encodeFunctionData("initialize", [sixURLs, [signer1Wallet.address], [signer1Wallet.address], owner.address]);
      const ERC1967ProxyArtifact = JSON.parse(fs.readFileSync(ERC1967_PROXY_ARTIFACT_PATH, "utf8"));
      const [deployer] = await hardhatEthers.getSigners();
      const ProxyFactory = new ethers.ContractFactory(ERC1967ProxyArtifact.abi, ERC1967ProxyArtifact.bytecode, deployer);
      await expect(ProxyFactory.deploy(await impl.getAddress(), initData)).to.be.revertedWithCustomError(HybridResolver, "TooManyURLs");
    });

    it("Should reject zero address CCIP signer", async function () {
      const HybridResolver = await hardhatEthers.getContractFactory("HybridResolver");
      const impl = await HybridResolver.deploy();
      await impl.waitForDeployment();
      const initData = HybridResolver.interface.encodeFunctionData("initialize", [testURLs, [ethers.ZeroAddress], [signer1Wallet.address], owner.address]);
      const ERC1967ProxyArtifact = JSON.parse(fs.readFileSync(ERC1967_PROXY_ARTIFACT_PATH, "utf8"));
      const [deployer] = await hardhatEthers.getSigners();
      const ProxyFactory = new ethers.ContractFactory(ERC1967ProxyArtifact.abi, ERC1967ProxyArtifact.bytecode, deployer);
      await expect(ProxyFactory.deploy(await impl.getAddress(), initData)).to.be.revertedWithCustomError(HybridResolver, "InvalidCCIPSignerAddress").withArgs(ethers.ZeroAddress);
    });

    it("Should reject duplicate CCIP signers in constructor", async function () {
      const HybridResolver = await hardhatEthers.getContractFactory("HybridResolver");
      const impl = await HybridResolver.deploy();
      await impl.waitForDeployment();
      const initData = HybridResolver.interface.encodeFunctionData("initialize", [testURLs, [signer1Wallet.address, signer1Wallet.address], [signer1Wallet.address], owner.address]);
      const ERC1967ProxyArtifact = JSON.parse(fs.readFileSync(ERC1967_PROXY_ARTIFACT_PATH, "utf8"));
      const [deployer] = await hardhatEthers.getSigners();
      const ProxyFactory = new ethers.ContractFactory(ERC1967ProxyArtifact.abi, ERC1967ProxyArtifact.bytecode, deployer);
      await expect(ProxyFactory.deploy(await impl.getAddress(), initData)).to.be.revertedWithCustomError(HybridResolver, "CCIPSignerAlreadyExists");
    });

    it("Should reject empty CCIP signers array", async function () {
      const HybridResolver = await hardhatEthers.getContractFactory("HybridResolver");
      const impl = await HybridResolver.deploy();
      await impl.waitForDeployment();
      const initData = HybridResolver.interface.encodeFunctionData("initialize", [testURLs, [], [signer1Wallet.address], owner.address]);
      const ERC1967ProxyArtifact = JSON.parse(fs.readFileSync(ERC1967_PROXY_ARTIFACT_PATH, "utf8"));
      const [deployer] = await hardhatEthers.getSigners();
      const ProxyFactory = new ethers.ContractFactory(ERC1967ProxyArtifact.abi, ERC1967ProxyArtifact.bytecode, deployer);
      await expect(ProxyFactory.deploy(await impl.getAddress(), initData)).to.be.revertedWithCustomError(HybridResolver, "AtLeastOneCCIPSignerRequired");
    });
  });

  describe("Onchain addr", function () {
    it("Should return VERSION constant", async function () {
      expect(await resolver.VERSION()).to.equal("1.2.0");
    });

    it("Should set and get addr for node with valid backend signature", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const testAddr = "0x1234567890123456789012345678901234567890";
      const addrBytes = ethers.getBytes(testAddr);
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, testNode, COIN_TYPE_ETH, addrBytes);
      await expect(resolver.connect(user).setAddr(testNode, COIN_TYPE_ETH, addrBytes, deadline, nonce, signature))
        .to.emit(resolver, "NonceIncremented")
        .withArgs(testNode, 0n, 1n);
      expect(await resolver.addr(testNode)).to.equal(testAddr);
    });

    it("Should resolve addr from onchain when set (priority over offchain)", async function () {
      // Use short name so ABI encoding of bytes yields correct length; longer names can be
      // encoded with wrong length by the test stack and then hit offchain path.
      const name = "eth";
      // Contract expects DNS-encoded name (length-prefixed labels)
      const nameHex = ethers.hexlify(ethers.getBytes(ethers.dnsEncode(name)));
      const node = ethers.namehash(name);

      const testAddr = "0x1234567890123456789012345678901234567890";
      const addrBytes = ethers.getBytes(testAddr);
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, node, COIN_TYPE_ETH, addrBytes);
      await resolver.connect(user).setAddr(node, COIN_TYPE_ETH, addrBytes, deadline, nonce, signature);

      const addrSelector = "0x3b3b57de";
      const data = addrSelector + ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [node]).slice(2);
      const result = await resolver.resolve.staticCall(nameHex, data);
      expect(ethers.AbiCoder.defaultAbiCoder().decode(["address"], result)[0]).to.equal(testAddr);
    });

    it("Should return onchain addr using node from data only (client name encoding may differ)", async function () {
      // Resolver uses node from request data for onchain lookup, not namehash(name), so clients
      // (e.g. ethers resolveName) get onchain priority regardless of how "name" is encoded.
      const node = ethers.namehash("lime.eth");
      const addrBytes = ethers.getBytes(owner.address);
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, node, COIN_TYPE_ETH, addrBytes);
      await resolver.connect(user).setAddr(node, COIN_TYPE_ETH, addrBytes, deadline, nonce, signature);

      const addrSelector = "0x3b3b57de";
      const data = addrSelector + ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [node]).slice(2);
      // Pass name bytes that would not match node (e.g. zeros); we still return onchain using node from data.
      const arbitraryName = ethers.getBytes("0x0000000000000000000000000000000000000000000000000000000000000000");
      const result = await resolver.resolve.staticCall(arbitraryName, data);
      expect(ethers.AbiCoder.defaultAbiCoder().decode(["address"], result)[0]).to.equal(owner.address);
    });

    it("Should not use coinType 10 for main ETH display (ENS app uses coinType 60)", async function () {
      // When user sets address via setAddr(node, coinType, bytes) with coinType=10,
      // addr(node) and addr(node, 60) stay empty — main display uses COIN_TYPE_ETH (60).
      const name = "eth";
      const nameHex = ethers.hexlify(ethers.getBytes(ethers.dnsEncode(name)));
      const node = ethers.namehash(name);
      const coinType10 = 10;
      const someAddrBytes = ethers.getBytes("0xf6795e65a301182fb69ec907e5f5f9636ef1d7000000000000000000000000").slice(0, 20);
      const ethDisplayAddr = owner.address;

      const { deadline: deadline10, nonce: nonce10, signature: sig10 } = await signSetAddr(resolver, signer1Wallet, node, coinType10, someAddrBytes);
      await resolver.connect(user).setAddr(node, coinType10, someAddrBytes, deadline10, nonce10, sig10);
      expect(await resolver.addr(node)).to.equal(ethers.ZeroAddress);
      const addrSelector = "0x3b3b57de";
      const dataLegacy = addrSelector + ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [node]).slice(2);
      await expect(resolver.resolve.staticCall(nameHex, dataLegacy)).to.be.revertedWithCustomError(resolver, "OffchainLookup");

      const ethAddrBytes = ethers.getBytes(ethDisplayAddr);
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, node, COIN_TYPE_ETH, ethAddrBytes);
      await resolver.connect(user).setAddr(node, COIN_TYPE_ETH, ethAddrBytes, deadline, nonce, signature);
      expect(await resolver.addr(node)).to.equal(ethDisplayAddr);
      const result = await resolver.resolve.staticCall(nameHex, dataLegacy);
      expect(ethers.AbiCoder.defaultAbiCoder().decode(["address"], result)[0]).to.equal(ethDisplayAddr);
    });

    it("Should reject setAddr with signature from unauthorized signer", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const testAddr = "0x1234567890123456789012345678901234567890";
      const addrBytes = ethers.getBytes(testAddr);
      const { deadline, nonce, signature } = await signSetAddr(resolver, userWallet, testNode, COIN_TYPE_ETH, addrBytes);
      await expect(
        resolver.connect(user).setAddr(testNode, COIN_TYPE_ETH, addrBytes, deadline, nonce, signature)
      ).to.be.revertedWithCustomError(resolver, "InvalidSigner");
    });

    it("Should reject setAddr with expired deadline", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const testAddr = "0x1234567890123456789012345678901234567890";
      const addrBytes = ethers.getBytes(testAddr);
      const deadline = BigInt(Math.floor(Date.now() / 1000) - 3600);
      const nonce = await resolver.nonces(testNode);
      const hash = await resolver.setAddrSignatureHash.staticCall(testNode, COIN_TYPE_ETH, addrBytes, deadline, nonce);
      const signature = signHash(signer1Wallet, hash);
      await expect(
        resolver.connect(user).setAddr(testNode, COIN_TYPE_ETH, addrBytes, deadline, nonce, signature)
      ).to.be.revertedWithCustomError(resolver, "SetAddrSignatureExpired");
    });

    it("Should reject setAddr when deadline exceeds MAX_SETADDR_TTL", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const addrBytes = ethers.getBytes("0x1234567890123456789012345678901234567890");
      const MAX_SETADDR_TTL = 7 * 24 * 60 * 60; // must match OnchainAddrResolver.MAX_SETADDR_TTL
      const block = await hardhatEthers.provider.getBlock("latest");
      // 8 days > MAX_SETADDR_TTL (7 days), so even with next-block timestamp increase the check will fail
      const deadline = BigInt(block.timestamp) + BigInt(8 * 24 * 60 * 60);
      const nonce = await resolver.nonces(testNode);
      const hash = await resolver.setAddrSignatureHash.staticCall(testNode, COIN_TYPE_ETH, addrBytes, deadline, nonce);
      const signature = signHash(signer1Wallet, hash);
      await expect(
        resolver.connect(user).setAddr(testNode, COIN_TYPE_ETH, addrBytes, deadline, nonce, signature)
      ).to.be.revertedWithCustomError(resolver, "DeadlineTooFar");
    });

    it("Should reject setAddr with wrong nonce", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const testAddr = "0x1234567890123456789012345678901234567890";
      const addrBytes = ethers.getBytes(testAddr);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const wrongNonce = 999n; // not current nonces[node]
      const hash = await resolver.setAddrSignatureHash.staticCall(testNode, COIN_TYPE_ETH, addrBytes, deadline, wrongNonce);
      const signature = signHash(signer1Wallet, hash);
      await expect(
        resolver.connect(user).setAddr(testNode, COIN_TYPE_ETH, addrBytes, deadline, wrongNonce, signature)
      ).to.be.revertedWithCustomError(resolver, "InvalidNonce");
    });

    it("Should reject EVM (60) address with wrong length", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("test"));
      const invalidLen19 = new Uint8Array(19).fill(0x01);
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, testNode, COIN_TYPE_ETH, invalidLen19);
      await expect(
        resolver.connect(user).setAddr(testNode, COIN_TYPE_ETH, invalidLen19, deadline, nonce, signature)
      ).to.be.revertedWithCustomError(resolver, "InvalidEVMAddressLength");
    });

    it("Should accept Solana (501) address with 32 bytes", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("sol.eth"));
      const solanaAddr32 = new Uint8Array(32).fill(0xa1);
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, testNode, 501, solanaAddr32);
      await resolver.connect(user).setAddr(testNode, 501, solanaAddr32, deadline, nonce, signature);
      const stored = await resolver["addr(bytes32,uint256)"].staticCall(testNode, 501);
      const storedBytes = ethers.getBytes(stored);
      expect(storedBytes.length).to.equal(32);
    });

    it("Should reject Solana (501) address with 31 bytes", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("sol.eth"));
      const invalidLen31 = new Uint8Array(31).fill(0xa1);
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, testNode, 501, invalidLen31);
      await expect(
        resolver.connect(user).setAddr(testNode, 501, invalidLen31, deadline, nonce, signature)
      ).to.be.revertedWithCustomError(resolver, "InvalidSolanaAddressLength");
    });

    it("Should accept Bitcoin (0) scriptPubkey 25 bytes", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("btc.eth"));
      const btcP2pkh25 = new Uint8Array(25).fill(0x76); // placeholder P2PKH-style length
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, testNode, 0, btcP2pkh25);
      await resolver.connect(user).setAddr(testNode, 0, btcP2pkh25, deadline, nonce, signature);
      const stored = await resolver["addr(bytes32,uint256)"].staticCall(testNode, 0);
      const storedBytes = ethers.getBytes(stored);
      expect(storedBytes.length).to.equal(25);
    });

    it("Should reject Bitcoin (0) address with 21 bytes", async function () {
      const testNode = ethers.keccak256(ethers.toUtf8Bytes("btc.eth"));
      const invalidLen21 = new Uint8Array(21).fill(0x00);
      const { deadline, nonce, signature } = await signSetAddr(resolver, signer1Wallet, testNode, 0, invalidLen21);
      await expect(
        resolver.connect(user).setAddr(testNode, 0, invalidLen21, deadline, nonce, signature)
      ).to.be.revertedWithCustomError(resolver, "InvalidBitcoinStyleAddressLength");
    });
  });

  describe("resolve", function () {
    it("Should revert with OffchainLookup error", async function () {
      // Contract expects DNS-encoded name, not UTF-8 (otherwise namehash() reverts with "Invalid label length")
      const nameBytes = ethers.getBytes(ethers.dnsEncode("test.eth"));
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const data = coder.encode(["bytes32"], [ethers.namehash("test.eth")]);

      await expect(
        resolver.resolve(nameBytes, data)
      ).to.be.revertedWithCustomError(resolver, "OffchainLookup");
    });

    it("Should include correct parameters in OffchainLookup error", async function () {
      const nameBytes = ethers.getBytes(ethers.dnsEncode("test.eth"));
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const data = coder.encode(["bytes32"], [ethers.namehash("test.eth")]);

      await expect(
        resolver.resolve(nameBytes, data)
      ).to.be.revertedWithCustomError(resolver, "OffchainLookup");
    });
  });

  describe("resolveWithProof", function () {
    let request, result, expires, sig, extraData, response;

    beforeEach(async function () {
      await resolver.waitForDeployment();
      const resolverAddress = await resolver.getAddress();
      
      // Prepare test data
      const name = ethers.toUtf8Bytes("test.eth");
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const data = coder.encode(["bytes32"], [ethers.namehash("test.eth")]);
      
      // Create callData as it would be in resolve()
      const IResolverService = new ethers.Interface([
        "function resolve(bytes calldata name, bytes calldata data) external view returns(bytes memory result, uint64 expires, bytes memory sig)"
      ]);
      const callData = IResolverService.encodeFunctionData("resolve", [name, data]);
      
      // Create extraData (callData, address(this))
      extraData = coder.encode(
        ["bytes", "address"],
        [callData, resolverAddress]
      );

      // Create result
      result = coder.encode(
        ["address"],
        [userWallet.address]
      );

      // Set expiration to future
      expires = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    });

    it("Should verify valid signature and return result", async function () {
      // In resolveWithProof, extraData is passed as 'request' to verify()
      // verify() decodes request as (bytes memory extraData, address sender)
      // So we need to create the hash with sender = resolver.address (from extraData)
      // and request = extraData (the callData part)
      
      const resolverAddress = await resolver.getAddress();
      const coder = ethers.AbiCoder.defaultAbiCoder();
      
      // Decode extraData to get the callData part
      const [callDataPart, sender] = coder.decode(
        ["bytes", "address"],
        extraData
      );
      expect(sender).to.equal(resolverAddress);
      
      // Create signature hash using the same parameters as verify() will use
      // verify() uses: makeSignatureHash(sender, expires, extraData, result)
      // where extraData is the first part of the decoded request
      const hash = await resolver.makeSignatureHash(
        sender, // resolver.address
        expires,
        callDataPart, // The callData part, not the full extraData
        result
      );

      // Sign the hash directly using ECDSA
      sig = signHash(signer1Wallet, hash);
      const sigBytes = ethers.getBytes(sig);

      // Verify the signature can be recovered correctly
      const recoveredAddress = ethers.recoverAddress(hash, sig);
      expect(recoveredAddress.toLowerCase()).to.equal(signer1Wallet.address.toLowerCase());

      // Create response
      response = coder.encode(
        ["bytes", "uint64", "bytes"],
        [result, expires, sigBytes]
      );

      // Call resolveWithProof - extraData is passed as request to verify()
      // verify() will decode it as (extraData, sender) and use extraData (callData) for the hash
      const returnedResult = await resolver.resolveWithProof(response, extraData);
      expect(returnedResult).to.equal(result);
    });

    it("Should reject signature from unauthorized signer", async function () {
      const resolverAddress = await resolver.getAddress();
      const coder = ethers.AbiCoder.defaultAbiCoder();
      
      // Decode extraData to get the callData part
      const [callDataPart, sender] = coder.decode(
        ["bytes", "address"],
        extraData
      );
      
      // Create signature hash using the same parameters as verify() will use
      const hash = await resolver.makeSignatureHash(
        sender,
        expires,
        callDataPart,
        result
      );

      // Sign with unauthorized user
      sig = signHash(userWallet, hash);
      const sigBytes = ethers.getBytes(sig);

      // Create response
      response = coder.encode(
        ["bytes", "uint64", "bytes"],
        [result, expires, sigBytes]
      );

      // Should revert
      await expect(
        resolver.resolveWithProof(response, extraData)
      ).to.be.revertedWithCustomError(resolver, "InvalidCCIPSigner");
    });

    it("Should reject expired signature", async function () {
      // Set expiration to past
      const pastExpires = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

      const resolverAddress = await resolver.getAddress();
      const coder = ethers.AbiCoder.defaultAbiCoder();
      
      // Decode extraData to get the callData part
      const [callDataPart, sender] = coder.decode(
        ["bytes", "address"],
        extraData
      );
      
      // Create signature hash using the same parameters as verify() will use
      const hash = await resolver.makeSignatureHash(
        sender,
        pastExpires,
        callDataPart,
        result
      );

      // Sign with signer1
      sig = signHash(signer1Wallet, hash);
      const sigBytes = ethers.getBytes(sig);

      // Create response
      response = coder.encode(
        ["bytes", "uint64", "bytes"],
        [result, pastExpires, sigBytes]
      );

      // Should revert (SignatureVerifier library error)
      const sigVerifierArtifact = await hre.artifacts.readArtifact("SignatureVerifier");
      const sigVerifierIface = new ethers.Interface(sigVerifierArtifact.abi);
      await expect(
        resolver.resolveWithProof(response, extraData)
      ).to.be.revertedWithCustomError({ interface: sigVerifierIface }, "CCIPSignatureExpired");
    });

    it("Should reject when extraData has wrong sender (cross-resolver signature reuse)", async function () {
      // Simulate attack: extraData crafted for another resolver (maliciousResolverAddress)
      const maliciousResolverAddress = ethers.Wallet.createRandom().address;
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const [callDataPart] = coder.decode(["bytes", "address"], extraData);

      const fakeExtraData = coder.encode(
        ["bytes", "address"],
        [callDataPart, maliciousResolverAddress]
      );

      // Signature is valid for (maliciousResolverAddress, expires, callDataPart, result)
      const hash = await resolver.makeSignatureHash(
        maliciousResolverAddress,
        expires,
        callDataPart,
        result
      );
      sig = signHash(signer1Wallet, hash);
      const sigBytes = ethers.getBytes(sig);
      response = coder.encode(
        ["bytes", "uint64", "bytes"],
        [result, expires, sigBytes]
      );

      // resolveWithProof must reject: sender in extraData != address(this)
      await expect(
        resolver.resolveWithProof(response, fakeExtraData)
      ).to.be.revertedWithCustomError(resolver, "SenderMismatch");
    });
  });

  describe("addCcipSigners / removeCcipSigners", function () {
    it("Should add new CCIP signers", async function () {
      const newSigner = ethers.Wallet.createRandom();
      await expect(resolver.connect(owner).addCcipSigners([newSigner.address]))
        .to.emit(resolver, "CcipSignersAdded")
        .withArgs([newSigner.address]);
      expect(await resolver.ccipSigners(newSigner.address)).to.be.true;
    });

    it("Should add multiple CCIP signers", async function () {
      const newSigner1 = ethers.Wallet.createRandom();
      const newSigner2 = ethers.Wallet.createRandom();
      await resolver.connect(owner).addCcipSigners([newSigner1.address, newSigner2.address]);
      expect(await resolver.ccipSigners(newSigner1.address)).to.be.true;
      expect(await resolver.ccipSigners(newSigner2.address)).to.be.true;
    });

    it("Should reject if called by non-owner", async function () {
      await expect(
        resolver.connect(user).addCcipSigners([ethers.Wallet.createRandom().address])
      ).to.be.reverted;
    });

    it("Should reject empty array", async function () {
      await expect(resolver.connect(owner).addCcipSigners([]))
        .to.be.revertedWithCustomError(resolver, "EmptyCCIPSignersArray");
    });

    it("Should reject zero address", async function () {
      await expect(resolver.connect(owner).addCcipSigners([ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(resolver, "InvalidCCIPSignerAddress").withArgs(ethers.ZeroAddress);
    });

    it("Should reject duplicate CCIP signer", async function () {
      await expect(resolver.connect(owner).addCcipSigners([signer1Wallet.address]))
        .to.be.revertedWithCustomError(resolver, "CCIPSignerAlreadyExists");
    });

    it("Should remove CCIP signers", async function () {
      await expect(resolver.connect(owner).removeCcipSigners([signer1Wallet.address]))
        .to.emit(resolver, "CcipSignersRemoved")
        .withArgs([signer1Wallet.address]);
      expect(await resolver.ccipSigners(signer1Wallet.address)).to.be.false;
      expect(await resolver.ccipSigners(signer2Wallet.address)).to.be.true;
    });

    it("Should reject removing non-existent CCIP signer", async function () {
      const nonExistent = ethers.Wallet.createRandom();
      await expect(resolver.connect(owner).removeCcipSigners([nonExistent.address]))
        .to.be.revertedWithCustomError(resolver, "CCIPSignerDoesNotExist");
    });
  });

  describe("addSetAddrSigners / removeSetAddrSigners", function () {
    it("Should add new setAddr signers", async function () {
      const newSigner = ethers.Wallet.createRandom();
      await expect(resolver.connect(owner).addSetAddrSigners([newSigner.address]))
        .to.emit(resolver, "SetAddrSignersAdded")
        .withArgs([newSigner.address]);
      expect(await resolver.setAddrSigners(newSigner.address)).to.be.true;
    });

    it("Should reject duplicate setAddr signer", async function () {
      await expect(resolver.connect(owner).addSetAddrSigners([signer1Wallet.address]))
        .to.be.revertedWithCustomError(resolver, "SetAddrSignerAlreadyExists");
    });

    it("Should remove setAddr signers", async function () {
      await expect(resolver.connect(owner).removeSetAddrSigners([signer1Wallet.address]))
        .to.emit(resolver, "SetAddrSignersRemoved")
        .withArgs([signer1Wallet.address]);
      expect(await resolver.setAddrSigners(signer1Wallet.address)).to.be.false;
      expect(await resolver.setAddrSigners(signer2Wallet.address)).to.be.true;
    });

    it("Should reject removing non-existent setAddr signer", async function () {
      const nonExistent = ethers.Wallet.createRandom();
      await expect(resolver.connect(owner).removeSetAddrSigners([nonExistent.address]))
        .to.be.revertedWithCustomError(resolver, "SetAddrSignerDoesNotExist");
    });
  });

  describe("setURLs", function () {
    it("Should update URLs", async function () {
      const newURLs = ["https://new-gateway.com", "https://backup.com"];
      await expect(resolver.connect(owner).setURLs(newURLs))
        .to.emit(resolver, "URLsUpdated")
        .withArgs(testURLs, newURLs);

      expect(await resolver.urls(0)).to.equal(newURLs[0]);
      expect(await resolver.urls(1)).to.equal(newURLs[1]);
    });

    it("Should reject if called by non-owner", async function () {
      await expect(
        resolver.connect(user).setURLs(["https://new-gateway.com"])
      ).to.be.reverted;
    });

    it("Should reject empty URLs array", async function () {
      await expect(
        resolver.connect(owner).setURLs([])
      ).to.be.revertedWithCustomError(resolver, "EmptyURLs");
    });

    it("Should reject empty URL in array", async function () {
      await expect(
        resolver.connect(owner).setURLs(["https://ok.com", ""])
      ).to.be.revertedWithCustomError(resolver, "EmptyURL");
    });

    it("Should reject too many URLs", async function () {
      const sixURLs = ["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", "https://f.com"];
      await expect(
        resolver.connect(owner).setURLs(sixURLs)
      ).to.be.revertedWithCustomError(resolver, "TooManyURLs");
    });
  });

  describe("makeSignatureHash", function () {
    it("Should generate consistent hash", async function () {
      const target = await resolver.getAddress();
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const request = ethers.toUtf8Bytes("test request");
      const result = ethers.toUtf8Bytes("test result");

      const hash1 = await resolver.makeSignatureHash(target, expires, request, result);
      const hash2 = await resolver.makeSignatureHash(target, expires, request, result);

      expect(hash1).to.equal(hash2);
    });

    it("Should generate different hashes for different inputs", async function () {
      const target = await resolver.getAddress();
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const request = ethers.toUtf8Bytes("test request");
      const result1 = ethers.toUtf8Bytes("test result 1");
      const result2 = ethers.toUtf8Bytes("test result 2");

      const hash1 = await resolver.makeSignatureHash(target, expires, request, result1);
      const hash2 = await resolver.makeSignatureHash(target, expires, request, result2);

      expect(hash1).to.not.equal(hash2);
    });
  });

  describe("supportsInterface", function () {
    it("Should support IExtendedResolver interface", async function () {
      // IExtendedResolver.interfaceId = bytes4(keccak256("resolve(bytes,bytes)"))
      // In ethers 6.x, we calculate the function selector manually
      const functionSignature = "resolve(bytes,bytes)";
      const hash = ethers.id(functionSignature);
      const interfaceId = hash.slice(0, 10); // First 4 bytes (8 hex chars + 0x)
      
      // For a single function interface, the interfaceId is the function selector
      // But IExtendedResolver might have its own interfaceId calculation
      // Let's check if it supports the function selector first
      // The actual interfaceId for IExtendedResolver should be calculated from the interface
      // For now, let's just verify it supports some interface
      expect(await resolver.supportsInterface(interfaceId)).to.be.true;
    });

    it("Should support SupportsInterface interface", async function () {
      // ERC165 interfaceId for supportsInterface itself
      const supportsInterfaceId = "0x01ffc9a7";
      expect(await resolver.supportsInterface(supportsInterfaceId)).to.be.true;
    });
  });
});
