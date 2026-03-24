# Hybrid ENS resolver contracts

Solidity contracts for ENS resolution that combine **onchain address storage** (`setAddr`) with **offchain data** via CCIP Read (EIP-3668) and ENSIP-10 wildcard resolution.

**Repository:** [lime-development/hybrid-ens-resolver-contracts](https://github.com/lime-development/hybrid-ens-resolver-contracts)

## Disclaimer

These contracts build on ideas and patterns from the official [ENS Offchain Resolver](https://github.com/ensdomains/offchain-resolver). We extend our thanks to the ENS team for the original architecture.

**Original reference:** https://github.com/ensdomains/offchain-resolver

## Acknowledgments

We thank the ENS (Ethereum Name Service) team and everyone who contributed to the offchain-resolver ecosystem.

## Architecture

| Layer | Role |
|-------|------|
| **Onchain** | For **`addr`** resolution (`addr(bytes32)` / `addr(bytes32,uint256)` selectors), the contract reads stored records first. **`setAddr`** writes are authorized by **setAddr signer** ECDSA signatures over `(node, coinType, addressBytes, resolver, deadline, nonce)` with **per-node nonce** replay protection and **`MAX_SETADDR_TTL`** (7 days). |
| **Offchain** | If onchain storage does not satisfy the request (e.g. no addr set, or a non-`addr` call), `resolve` reverts with **`OffchainLookup`** (EIP-3668); the client calls the gateway, then **`resolveWithProof`**, which checks **`ccipSigners`** (hot keys for short-lived gateway responses). |

The deployed **`HybridResolver`** is **UUPS upgradeable** (owner-only `upgradeToAndCall`). **Ownership cannot be renounced** (`renounceOwnership` reverts) so upgrades remain possible. It does **not** accept ETH (no `receive` / generic `fallback`).

## Contracts

### HybridResolver.sol

Main deployable resolver. Inherits **`OnchainAddrResolver`** and implements:

- **EIP-3668** (CCIP Read) and **ENSIP-10** extended **`resolve`** / **`resolveWithProof`**
- **Onchain `addr` fast path**: `resolve` only checks storage for the legacy and multicoin **`addr`** selectors; other `data` payloads go to the CCIP path (still via `OffchainLookup`).
- **Two signer sets** (do not confuse them):
  - **`ccipSigners`** — verify gateway responses for CCIP-Read (hot keys; can be rotated by owner; removing all pauses offchain resolution)
  - **`setAddrSigners`** — authorize **`setAddr(...)`** that writes multichain addresses onchain (cold keys; multisig / hardware in production)
- **Gateway URLs** — up to **5** non-empty URLs; CCIP clients may try them in order
- **Ownable** admin for signers, URLs, and upgrades
- **`supportsInterface`**: `IERC165`, `IExtendedResolver`, `IAddrResolver`, `IAddressResolver`

Onchain constant **`VERSION`** (semver string, e.g. `1.2.0`) is exposed for tooling.

### OnchainAddrResolver.sol

Abstract base: **`IAddrResolver`** + **`IAddressResolver`** with storage, **`setAddr`** gated by backend-signed payloads (node, coinType, address bytes, deadline, nonce). Enforces per-coin address lengths (ENSIP-9 / EIP-2304 style), **`MAX_SETADDR_TTL`** (e.g. 7 days), and **`NonceIncremented`** for indexers.

### SignatureVerifier.sol

Library for CCIP gateway responses: **`makeSignatureHash`** / **`verify`** use a fixed **`0x1900`** prefix and `keccak256` over target, expiry, request, and result (same general idea as [ensdomains/offchain-resolver](https://github.com/ensdomains/offchain-resolver); **not** EIP-191 / EIP-712). Expiry is enforced onchain. **setAddr** in `OnchainAddrResolver` uses a **separate** hash: EIP-191–style `toEthSignedMessageHash` over the packed payload — the gateway for CCIP must match `SignatureVerifier`, the backend for `setAddr` must match `setAddrSignatureHash`.

### IExtendedResolver.sol

Extended resolver interface (ENSIP-10 style) used by `HybridResolver`.

## Features

- Onchain multichain addresses with backend-authorized `setAddr`
- Offchain resolution via CCIP Read when onchain data is absent
- Wildcard / ENSIP-10 resolution path
- Separate CCIP vs setAddr signer roles
- UUPS upgrades (owner only)
- Contract tests in `test/HybridResolver.test.js` (Hardhat + Mocha)

## Installation

From the repository root:

```bash
npm install
```

## Compilation

```bash
npm run compile
# or
npx hardhat compile
```

## Testing

```bash
npm test
```

| Script | Purpose |
|--------|---------|
| `npm test` | All tests under `test/**/*.test.js` (see `.mocharc.json`) |
| `npm run test:unit` | Tests whose titles **do not** match `Integration` (today this is the full suite) |
| `npm run test:integration` | Only tests whose titles match `Integration` (add such tests when you ship gateway E2E coverage) |

The main suite is **`test/HybridResolver.test.js`**: deployment, `resolve` / `resolveWithProof`, `setAddr`, CCIP vs setAddr signer management, URLs, and related cases.

## Configuration

Create a `.env` file in the **project root** (next to `hardhat.config.js`). Copy [example.env](example.env) and set RPC URLs, deployer key, gateway URL(s), signer addresses, and owner as needed.

## Deployment

### Quick deployment

**Sepolia:**

```bash
npm install
npm run compile
npm run deploy:sepolia
```

**Mainnet:**

```bash
npm install
npm run compile
npm run deploy:mainnet
```

After deployment, metadata is saved to **`deployments/<network>.json`** (proxy address, implementation, gateway URLs, signers, owner).

### Setting the resolver in ENS

Point your name’s resolver to the deployed proxy address in [ENS App](https://app.ens.domains/) (or your registrar flow).

### Verification

```bash
npm run verify:sepolia
# or
npm run verify:mainnet
```

Or:

```bash
npx hardhat run scripts/verify.js --network <network>
```

## Operations

### Gateway URLs (owner)

```solidity
resolver.setURLs(["https://gateway-1.example/", "https://gateway-2.example/"]);
```

### CCIP signers (offchain response signing)

```solidity
resolver.addCcipSigners([newCcipSigner]);
resolver.removeCcipSigners([oldCcipSigner]);
```

### SetAddr signers (onchain `setAddr` authorization)

```solidity
resolver.addSetAddrSigners([newSetAddrSigner]);
resolver.removeSetAddrSigners([oldSetAddrSigner]);
```

The backend that users call for `setAddr` signatures must use a key that matches an active **`setAddrSigner`**, not necessarily a `ccipSigner`.

## Technical Details

- **Solidity**: `^0.8.30`
- **License**: MIT
- **Dependencies**:
  - `@ensdomains/ens-contracts` — ENS resolver interfaces and profiles
  - `@openzeppelin/contracts` / `contracts-upgradeable` — UUPS, Ownable, ECDSA

## License

MIT License — aligned with common practice in this ecosystem.

## References

- [ENS Documentation](https://docs.ens.domains/)
- [EIP-3668: CCIP Read](https://eips.ethereum.org/EIPS/eip-3668)
- [ENSIP-10: Wildcard Resolution](https://docs.ens.domains/ensip/ensip-10)
- [Original offchain-resolver](https://github.com/ensdomains/offchain-resolver)
