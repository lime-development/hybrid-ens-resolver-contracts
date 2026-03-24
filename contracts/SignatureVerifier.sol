// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library SignatureVerifier {
    error CCIPInvalidSignature();
    error CCIPSignatureExpired();

    /**
     * @dev Generates a hash for signing/verifying offchain CCIP-Read responses.
     * Uses custom prefix hex"1900" (not EIP-191 or EIP-712). This is an intentional choice:
     * simpler for the gateway (no domain separator, no typed structs). The reference
     * implementation (ensdomains/offchain-resolver) uses the same approach. The backend
     * must sign the raw hash returned here (no "\x19Ethereum signed message" wrapper).
     * HybridResolver.resolve() verifies responses using this same hash via SignatureVerifier.verify();
     * the backend's CreateSignatureHash (or equivalent) must stay in sync with this implementation.
     * @param target The address the signature is for (resolver contract).
     * @param request The original request (callData) that was sent.
     * @param result The `result` field of the response (not including the signature part).
     */
    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result) internal pure returns(bytes32) {
        return keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)));
    }

    /**
     * @dev Verifies a signed message returned from a callback.
     * @param callData: The original request (first field of extraData from CCIP-Read).
     * @param sender: The resolver address the signature is for (second field of extraData).
     * @param response: ABI-encoded (bytes result, uint64 expires, bytes sig).
     * @return signer: The address that signed this message.
     * @return result: The `result` decoded from `response`.
     */
    function verify(bytes memory callData, address sender, bytes calldata response) internal view returns(address, bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        address signer = ECDSA.recover(makeSignatureHash(sender, expires, callData, result), sig);
        if (signer == address(0)) revert CCIPInvalidSignature();
        // Expiration check is intentional; bounded time window; miner skew is at most ~15s and is acceptable for offchain response validity.
        // slither-disable-next-line timestamp
        if (expires < block.timestamp) revert CCIPSignatureExpired();
        return (signer, result);
    }
}
