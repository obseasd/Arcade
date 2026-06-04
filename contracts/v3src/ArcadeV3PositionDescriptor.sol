// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-periphery/contracts/interfaces/INonfungibleTokenPositionDescriptor.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";

// Position-NFT metadata resolver wired into ArcadeV3PositionManager via the
// canonical `_tokenDescriptor_` constructor slot. Returns an off-chain URL
// (/api/v3-position/<id>) so we can iterate on the JSON + image without
// redeploying the contract.
contract ArcadeV3PositionDescriptor is INonfungibleTokenPositionDescriptor {
    string private constant BASE = "https://www.arcade.trading/api/v3-position/";

    function tokenURI(INonfungiblePositionManager, uint256 tokenId)
        external
        view
        override
        returns (string memory)
    {
        return string(abi.encodePacked(BASE, _toDecimal(tokenId)));
    }

    // uint -> ASCII decimal helper. Solidity 0.7 lacks Strings.toString so we
    // inline a single-allocation pass.
    function _toDecimal(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
