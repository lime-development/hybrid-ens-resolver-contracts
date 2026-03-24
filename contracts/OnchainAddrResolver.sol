// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@ensdomains/ens-contracts/contracts/resolvers/profiles/IAddrResolver.sol";
import "@ensdomains/ens-contracts/contracts/resolvers/profiles/IAddressResolver.sol";
import {ENSIP19, COIN_TYPE_ETH, COIN_TYPE_DEFAULT} from "@ensdomains/ens-contracts/contracts/utils/ENSIP19.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * Onchain address resolution for ENS.
 * Implements IAddrResolver and IAddressResolver with storage.
 * setAddr requires a backend signature (address, node, contract, timestamp) so only
 * authorized backend can allow which address is set for a node.
 * Address byte length is validated per ENSIP-9 / EIP-2304 for known coin types.
 */
abstract contract OnchainAddrResolver is IAddrResolver, IAddressResolver {
    error SetAddrSignatureExpired();
    error DeadlineTooFar();
    error InvalidNonce();
    error SetAddrInvalidSignature();
    error InvalidSigner();
    error InvalidEVMRSKAddressLength();
    error InvalidEVMAddressLength();
    error InvalidBitcoinStyleAddressLength();
    error InvalidRippleAddressLength();
    error InvalidSolanaAddressLength();
    error AddressLengthExceedsMaximum();

    /// @dev Max TTL for setAddr signatures; prevents effectively eternal, unrevocable signatures (e.g. deadline = type(uint64).max).
    uint64 public constant MAX_SETADDR_TTL = uint64(7 days);

    /// @dev Max allowed length for unknown coin types (prevents DoS from huge payloads). Owner/gateway trust: only backend-signed data is stored.
    uint256 private constant MAX_UNKNOWN_COIN_ADDRESS_LENGTH = 64;
    // Storage: node => coinType => address bytes
    mapping(bytes32 => mapping(uint256 => bytes)) private _addresses;
    // Per-node nonce for setAddr replay protection; backend must sign current nonce
    mapping(bytes32 => uint256) public nonces;

    /// @dev Reserved storage for future upgrades; reduces layout when adding new vars in base.
    // slither-disable-next-line naming-convention,unused-state
    uint256[48] private __gap;

    /// @dev Emitted when nonce is incremented after setAddr; indexers track current nonce per node via newNonce.
    /// @param usedNonce The nonce that was used for this setAddr (consumed).
    /// @param newNonce The new current nonce (usedNonce + 1) for the next setAddr.
    event NonceIncremented(bytes32 indexed node, uint256 usedNonce, uint256 newNonce);

    /**
     * Returns the address associated with an ENS node (legacy, ETH only).
     */
    function addr(bytes32 node) public view virtual override returns (address payable) {
        bytes memory addrBytes = _addresses[node][COIN_TYPE_ETH];
        if (addrBytes.length == 20) {
            return payable(address(bytes20(addrBytes)));
        }
        return payable(address(0));
    }

    /**
     * Returns the address for a specific coin type.
     */
    function addr(bytes32 node, uint256 coinType) public view virtual override returns (bytes memory addressBytes) {
        addressBytes = _addresses[node][coinType];
        if (addressBytes.length == 0 && ENSIP19.isEVMCoinType(coinType) && coinType != COIN_TYPE_DEFAULT) {
            addressBytes = _addresses[node][COIN_TYPE_DEFAULT];
        }
        return addressBytes;
    }

    /**
     * Checks whether the given address is allowed to sign setAddr authorizations.
     * Must be overridden by the resolver that holds the backend signer list.
     */
    function _isValidSetAddrSigner(address signer) internal view virtual returns (bool);

    /**
     * Builds the hash that the backend must sign for setAddr(node, coinType, addressBytes).
     * Payload: node, coinType, addressBytes, contract address, deadline, nonce.
     * Backend must use the current nonces[node] when signing; nonce is incremented after each setAddr.
     * For ETH address use coinType 60 (COIN_TYPE_ETH) and addressBytes = abi.encodePacked(addr).
     */
    function setAddrSignatureHash(bytes32 node, uint256 coinType, bytes memory addressBytes, uint64 deadline, uint256 nonce) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encodePacked(node, coinType, addressBytes, address(this), deadline, nonce))
        );
    }

    /**
     * Sets the address for a specific coin type.
     * Callable by any address; authorization is solely via the backend signature. A valid signature
     * may be submitted by the intended user or by any other party (e.g. from the mempool). Front-running
     * (submitting the same signed call first) does not benefit the front-runner: the same signed
     * (node, coinType, addressBytes) is written regardless of who calls.
     * Requires a valid backend signature over (node, coinType, addressBytes, address(this), deadline, nonce).
     * Nonce must equal current nonces[node] and is incremented after the call (replay protection).
     * For legacy ETH display use coinType 60 (COIN_TYPE_ETH).
     */
    function setAddr(bytes32 node, uint256 coinType, bytes memory addressBytes, uint64 deadline, uint256 nonce, bytes calldata signature) public virtual {
        // Deadline check is intentional; miner timestamp skew is at most ~15s and is acceptable for setAddr signature validity.
        // slither-disable-next-line timestamp
        if (deadline < block.timestamp) revert SetAddrSignatureExpired();
        // Upper bound on TTL is intentional; same miner skew acceptance as expiry check.
        // slither-disable-next-line timestamp
        if (deadline > block.timestamp + MAX_SETADDR_TTL) revert DeadlineTooFar();
        if (nonce != nonces[node]) revert InvalidNonce();
        address signer = ECDSA.recover(setAddrSignatureHash(node, coinType, addressBytes, deadline, nonce), signature);
        if (signer == address(0)) revert SetAddrInvalidSignature();
        if (!_isValidSetAddrSigner(signer)) revert InvalidSigner();
        uint256 usedNonce = nonces[node];
        nonces[node] = usedNonce + 1;
        emit NonceIncremented(node, usedNonce, usedNonce + 1);
        _setAddr(node, coinType, addressBytes);
    }

    /**
     * Validates address byte length for the given coin type per ENSIP-9 / EIP-2304.
     * Reverts if length is invalid for that coin type.
     */
    function _requireValidAddressLength(uint256 coinType, uint256 length) internal pure {
        if (length == 0) return;
        if (ENSIP19.isEVMCoinType(coinType)) {
            // EVM: 20 bytes (60, 61, 614, 714, etc.); Rootstock 137 may use 30 bytes (RSKIP60).
            if (coinType == 137) {
                if (length != 20 && length != 30) revert InvalidEVMRSKAddressLength();
            } else {
                if (length != 20) revert InvalidEVMAddressLength();
            }
            return;
        }
        // Non-EVM: known coin types from ENSIP-9 / EIP-2304
        if (coinType == 0 || coinType == 2 || coinType == 3 || coinType == 22 || coinType == 145) {
            // Bitcoin, Litecoin, Dogecoin, Monacoin, Bitcoin Cash: scriptPubkey 22–43 bytes
            if (length < 22 || length > 43) revert InvalidBitcoinStyleAddressLength();
            return;
        }
        if (coinType == 144) {
            // Ripple: r-address 21 bytes or X-address 34 bytes
            if (length != 21 && length != 34) revert InvalidRippleAddressLength();
            return;
        }
        if (coinType == 501) {
            // Solana: ed25519 pubkey 32 bytes
            if (length != 32) revert InvalidSolanaAddressLength();
            return;
        }
        // Unknown coin type: allow up to a safe maximum
        if (length > MAX_UNKNOWN_COIN_ADDRESS_LENGTH) revert AddressLengthExceedsMaximum();
    }

    /**
     * Internal: sets the address for a specific coin type.
     */
    function _setAddr(bytes32 node, uint256 coinType, bytes memory addressBytes) internal virtual {
        _requireValidAddressLength(coinType, addressBytes.length);

        _addresses[node][coinType] = addressBytes;

        emit AddressChanged(node, coinType, addressBytes);
        if (coinType == COIN_TYPE_ETH) {
            emit AddrChanged(node, addressBytes.length == 20 ? address(bytes20(addressBytes)) : address(0));
        }
    }
}
