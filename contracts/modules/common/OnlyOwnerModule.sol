pragma solidity ^0.4.24;
import "./BaseModule.sol";
import "./RelayerModule.sol";
import "../../wallet/BaseWallet.sol";

/**
 * @title OnlyOwnerModule
 * @dev Module that extends BaseModule and RelayerModule for modules where the execute() method
 * must be called with one signature frm the owner.
 * @author Julien Niset - <julien@argent.im>
 */
contract OnlyOwnerModule is BaseModule, RelayerModule {

    // *************** Implementation of RelayerModule methods ********************* //

    // Overrides to use the incremental nonce and save some gas
    function checkAndUpdateUniqueness(BaseWallet _wallet, uint256 _nonce, bytes32 _signHash) internal returns (bool) {
        if(!isValidNonce(_nonce, relayer[_wallet].nonce)) {
            return false;
        }
        relayer[_wallet].nonce = _nonce;
        return true;
    }

    function validateSignatures(BaseWallet _wallet, bytes _data, bytes32 _signHash, bytes _signatures) internal view {
        address signer = recoverSigner(_signHash, _signatures, 0);
        require(isOwner(_wallet, signer), "OOM: signer must be owner");
    }

    function getRequiredSignatures(BaseWallet _wallet, bytes _data) internal view returns (uint256) {
        return 1;
    }
}