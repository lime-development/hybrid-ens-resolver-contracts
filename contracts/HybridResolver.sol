// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./IExtendedResolver.sol";
import "./SignatureVerifier.sol";
import "./OnchainAddrResolver.sol";
import "@ensdomains/ens-contracts/contracts/resolvers/profiles/IAddrResolver.sol";
import "@ensdomains/ens-contracts/contracts/resolvers/profiles/IAddressResolver.sol";

interface IResolverService {
    function resolve(bytes calldata name, bytes calldata data) external view returns(bytes memory result, uint64 expires, bytes memory sig);
}

/**
 * Hybrid ENS resolver: onchain address records with offchain (CCIP-Read) fallback.
 * Implements EIP 3668 / ENSIP 10. Onchain addr has priority over offchain resolution.
 * UUPS upgradeable: only owner can upgrade via upgradeToAndCall; new implementations must inherit UUPSUpgradeable.
 * No receive() or fallback(); contract does not accept ETH. Sending ETH will revert.
 */
contract HybridResolver is IExtendedResolver, OnchainAddrResolver, Initializable, OwnableUpgradeable, UUPSUpgradeable, IERC165 {
    // Contract version constant
    string public constant VERSION = "1.2.0";

    // ENS resolver function selectors (first 4 bytes of keccak256(signature))
    // IAddrResolver.addr(bytes32) and IAddressResolver.addr(bytes32,uint256)
    bytes4 private constant SELECTOR_ADDR_LEGACY = 0x3b3b57de;
    bytes4 private constant SELECTOR_ADDR_MULTICOIN = 0xf1cb7e06;

    /// @dev Max gateway URLs; limits write size to avoid out-of-gas partial updates (M-3).
    uint256 private constant MAX_URLS = 5;

    string[] public urls;
    /// @dev Hot keys: sign CCIP-Read responses only (short-lived, frequently rotated).
    mapping(address => bool) public ccipSigners;
    /// @dev Cold keys: authorize setAddr onchain (permanent storage; use multisig / hardware).
    mapping(address => bool) public setAddrSigners;

    /// @dev Reserved storage for future upgrades; reduces layout when adding new vars in base.
    // slither-disable-next-line naming-convention,unused-state
    uint256[47] private __gap;

    event CcipSignersAdded(address[] signers);
    event CcipSignersRemoved(address[] signers);
    event SetAddrSignersAdded(address[] signers);
    event SetAddrSignersRemoved(address[] signers);
    event URLsUpdated(string[] oldURLs, string[] newURLs);
   
    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);
    error InitialOwnerZero();
    error URLsCannotBeEmpty();
    error TooManyURLs();
    error URLCannotBeEmpty();
    error AtLeastOneCCIPSignerRequired();
    error InvalidCCIPSignerAddress(address signer);
    error CCIPSignerAlreadyExists();
    error InvalidSetAddrSignerAddress(address signer);
    error DuplicateSetAddrSigner();
    error RenounceOwnershipDisabled();
    error SenderMismatch();
    error InvalidCCIPSigner();
    error EmptyCCIPSignersArray();
    error EmptySetAddrSignersArray();
    error CCIPSignerDoesNotExist();
    error SetAddrSignerAlreadyExists();
    error SetAddrSignerDoesNotExist();
    error EmptyURLs();
    error EmptyURL();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Prevents implementation contract from being initialized (only proxy should run initialize).
        _disableInitializers();
    }

    /**
     * @dev Initializes the proxy. Must be called once by the proxy (e.g. in constructor data).
     * Initialize must be called atomically in the proxy constructor (via initData).
     * Never deploy the proxy without initData — leaves the proxy uninitialized and
     * vulnerable to front-running: anyone can call initialize() and become owner.
     */
    function initialize(string[] memory gatewayUrls, address[] memory ccipSignersList, address[] memory setAddrSignersList, address initialOwner) public initializer {
        if (initialOwner == address(0)) revert InitialOwnerZero();
        __Ownable_init(initialOwner);
        _initializeUrls(gatewayUrls);
        _initializeCcipSigners(ccipSignersList);
        _initializeSetAddrSigners(setAddrSignersList);
    }

    function _initializeUrls(string[] memory gatewayUrls) private {
        if (gatewayUrls.length == 0) revert URLsCannotBeEmpty();
        if (gatewayUrls.length > MAX_URLS) revert TooManyURLs();
        for (uint i = 0; i < gatewayUrls.length; i++) {
            if (bytes(gatewayUrls[i]).length == 0) revert URLCannotBeEmpty();
        }
        urls = gatewayUrls;
        emit URLsUpdated(new string[](0), gatewayUrls);
    }

    function _initializeCcipSigners(address[] memory ccipSignersList) private {
        if (ccipSignersList.length == 0) revert AtLeastOneCCIPSignerRequired();
        for (uint i = 0; i < ccipSignersList.length; i++) {
            if (ccipSignersList[i] == address(0)) revert InvalidCCIPSignerAddress(ccipSignersList[i]);
            if (ccipSigners[ccipSignersList[i]]) revert CCIPSignerAlreadyExists();
            ccipSigners[ccipSignersList[i]] = true;
        }
        emit CcipSignersAdded(ccipSignersList);
    }

    function _initializeSetAddrSigners(address[] memory setAddrSignersList) private {
        for (uint i = 0; i < setAddrSignersList.length; i++) {
            if (setAddrSignersList[i] == address(0)) revert InvalidSetAddrSignerAddress(setAddrSignersList[i]);
            if (setAddrSigners[setAddrSignersList[i]]) revert DuplicateSetAddrSigner();
            setAddrSigners[setAddrSignersList[i]] = true;
        }
        if (setAddrSignersList.length > 0) {
            emit SetAddrSignersAdded(setAddrSignersList);
        }
    }

    /// @dev Only owner can authorize an upgrade. Required by UUPSUpgradeable.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @dev Block renouncing ownership so UUPS upgrades remain possible.
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    /// @dev Hash used to verify offchain CCIP-Read response signatures. Backend must use the same
    /// construction (CreateSignatureHash) so that signed responses verify here. See SignatureVerifier.makeSignatureHash.
    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result) external pure returns(bytes32) {
        return SignatureVerifier.makeSignatureHash(target, expires, request, result);
    }

    /**
     * Resolves a name, as specified by ENSIP 10.
     * Checks onchain data first, then falls back to offchain resolution.
     * @param name The DNS-encoded name to resolve.
     * @param data The ABI encoded data for the underlying resolution function (Eg, addr(bytes32), text(bytes32,string), etc).
     * @return The return data, ABI encoded identically to the underlying function.
     */
    function resolve(bytes calldata name, bytes calldata data) external override view returns(bytes memory) {
        bytes4 selector = bytes4(data);

        // Onchain addr has priority over offchain. Use the node from the request (data), not namehash(name),
        // so that we return onchain data regardless of how the client encoded "name" (e.g. ABI vs raw DNS).
        if (selector == SELECTOR_ADDR_LEGACY) {
            bytes32 nodeParam = abi.decode(data[4:], (bytes32));
            address addrValue = addr(nodeParam);
            if (addrValue != address(0)) {
                return abi.encode(addrValue);
            }
        }

        if (selector == SELECTOR_ADDR_MULTICOIN) {
            (bytes32 nodeParam, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            bytes memory addrBytes = addr(nodeParam, coinType);
            if (addrBytes.length > 0) {
                return abi.encode(addrBytes);
            }
        }
        
        // Fallback to offchain resolution
        bytes memory callData = abi.encodeWithSelector(IResolverService.resolve.selector, name, data);
        revert OffchainLookup(
            address(this),
            urls,
            callData,
            HybridResolver.resolveWithProof.selector,
            abi.encode(callData, address(this))
        );
    }

    /**
     * Callback used by CCIP-Read compatible clients to verify and parse the gateway response.
     * May be called directly by any address (EIP-3668); the contract does not store call context
     * from resolve(), so direct invocation with valid (response, extraData) is valid and equivalent.
     * Ensures extraData was created for this resolver (sender == address(this)) to prevent
     * cross-resolver signature reuse (e.g. a signature issued for another resolver).
     */
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns(bytes memory) {
        (bytes memory callData, address sender) = abi.decode(extraData, (bytes, address));
        if (sender != address(this)) revert SenderMismatch();

        (address signer, bytes memory result) = SignatureVerifier.verify(callData, sender, response);
        if (!ccipSigners[signer]) revert InvalidCCIPSigner();
        return result;
    }

    /**
     * Add CCIP-Read signers (hot keys for gateway responses).
     */
    function addCcipSigners(address[] memory newSigners) external onlyOwner {
        if (newSigners.length == 0) revert EmptyCCIPSignersArray();
        for (uint i = 0; i < newSigners.length; i++) {
            if (newSigners[i] == address(0)) revert InvalidCCIPSignerAddress(newSigners[i]);
            if (ccipSigners[newSigners[i]]) revert CCIPSignerAlreadyExists();
            ccipSigners[newSigners[i]] = true;
        }
        emit CcipSignersAdded(newSigners);
    }

    /**
     * Remove CCIP-Read signers.
     * Removing all signers effectively pauses offchain (CCIP-Read) resolution —
     * resolveWithProof will revert with InvalidCCIPSigner until a new signer is added.
     * This serves as an emergency pause mechanism if the gateway is compromised.
     */
    function removeCcipSigners(address[] memory signersToRemove) external onlyOwner {
        if (signersToRemove.length == 0) revert EmptyCCIPSignersArray();
        for (uint i = 0; i < signersToRemove.length; i++) {
            if (!ccipSigners[signersToRemove[i]]) revert CCIPSignerDoesNotExist();
            ccipSigners[signersToRemove[i]] = false;
        }
        emit CcipSignersRemoved(signersToRemove);
    }

    /**
     * Add setAddr signers (cold keys for onchain address writes).
     */
    function addSetAddrSigners(address[] memory newSigners) external onlyOwner {
        if (newSigners.length == 0) revert EmptySetAddrSignersArray();
        for (uint i = 0; i < newSigners.length; i++) {
            if (newSigners[i] == address(0)) revert InvalidSetAddrSignerAddress(newSigners[i]);
            if (setAddrSigners[newSigners[i]]) revert SetAddrSignerAlreadyExists();
            setAddrSigners[newSigners[i]] = true;
        }
        emit SetAddrSignersAdded(newSigners);
    }

    /**
     * Remove setAddr signers.
     */
    function removeSetAddrSigners(address[] memory signersToRemove) external onlyOwner {
        if (signersToRemove.length == 0) revert EmptySetAddrSignersArray();
        for (uint i = 0; i < signersToRemove.length; i++) {
            if (!setAddrSigners[signersToRemove[i]]) revert SetAddrSignerDoesNotExist();
            setAddrSigners[signersToRemove[i]] = false;
        }
        emit SetAddrSignersRemoved(signersToRemove);
    }

    /**
     * Returns all gateway URLs (CCIP-Read clients may try them in order).
     */
    function getURLs() external view returns (string[] memory) {
        return urls;
    }

    /**
     * Update the gateway URLs.
     * @param newURLs The new gateway URLs (CCIP-Read clients may try them in order).
     */
    function setURLs(string[] memory newURLs) external onlyOwner {
        if (newURLs.length == 0) revert EmptyURLs();
        if (newURLs.length > MAX_URLS) revert TooManyURLs();
        for (uint i = 0; i < newURLs.length; i++) {
            if (bytes(newURLs[i]).length == 0) revert EmptyURL();
        }
        string[] memory oldURLs = urls;
        urls = newURLs;
        emit URLsUpdated(oldURLs, newURLs);
    }

    /**
     * Only setAddr signers (cold keys) may authorize onchain setAddr.
     */
    function _isValidSetAddrSigner(address signer) internal view override returns (bool) {
        return setAddrSigners[signer];
    }

    function supportsInterface(bytes4 interfaceID) public pure returns (bool) {
        return
            interfaceID == type(IERC165).interfaceId ||
            interfaceID == type(IExtendedResolver).interfaceId ||
            interfaceID == type(IAddrResolver).interfaceId ||
            interfaceID == type(IAddressResolver).interfaceId;
    }
}
