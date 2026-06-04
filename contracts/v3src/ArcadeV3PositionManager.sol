// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-periphery/contracts/NonfungiblePositionManager.sol";

/**
 * @title ArcadeV3PositionManager
 * @notice Arcade-branded fork of Uniswap V3 `NonfungiblePositionManager`.
 *         Behaviour is intentionally identical to the canonical NPM — every
 *         interaction (mint, increaseLiquidity, decreaseLiquidity, collect,
 *         burn, permit, multicall, ...) is inherited unchanged so the
 *         standard `INonfungiblePositionManager` interface is preserved and
 *         third-party tools (Revert Finance, Arrakis, Gamma, lending markets
 *         that accept V3 LP NFTs as collateral) work without integration.
 *
 *         Only three things differ from upstream:
 *
 *           1. `name()` / `symbol()` return Arcade branding so the position
 *              NFTs read as "Arcade V3 Positions NFT-V1" in wallets,
 *              explorers, marketplaces.
 *           2. `tokenURI()` is overridden to point at the Arcade metadata
 *              API instead of delegating to a `NonfungibleTokenPositionDescriptor`.
 *              Lets us iterate on the NFT image / metadata server-side
 *              without redeploying the contract.
 *           3. The constructor passes `address(0)` for the token-descriptor
 *              slot since we never use it (we override `tokenURI`) and
 *              accepts an `address(0)` for WETH9 — Arc has no native ETH,
 *              gas is USDC, and the WETH-wrapped paths are inert. The
 *              `mint(MintParams)` / `increaseLiquidity(...)` flows that
 *              don't touch WETH9 work normally.
 *
 *         IMPORTANT (caveat noted for the v1 audit):
 *         the inherited `ERC721Permit` constructor pins the EIP-712 domain
 *         `nameHash` to "Uniswap V3 Positions NFT-V1". Permit signatures
 *         therefore still verify against the Uniswap domain string, even
 *         though `name()` reads as Arcade. This is fine for v1 — third-party
 *         tools that sign permits typically read `name()`, so cross-tool
 *         compatibility holds. If we want a pure Arcade EIP-712 domain we
 *         have to fork ERC721Permit (deferred to v2).
 */
contract ArcadeV3PositionManager is NonfungiblePositionManager {
    string private constant _NAME = "Arcade V3 Positions NFT-V1";
    string private constant _SYMBOL = "ARC-V3-POS";
    /// @notice Base URI used by `tokenURI()`; appended with the decimal tokenId.
    string private constant _TOKEN_URI_BASE =
        "https://www.arcade.trading/api/v3-position/";

    /// @param _factory_  Arcade V3 factory (Uniswap V3 fork).
    /// @param _WETH9_    Wrapped-ETH address. Pass address(0) on Arc — the
    ///                   inherited WETH9-touching helpers (refundETH,
    ///                   unwrapWETH9, ...) become inert, which is what we want.
    constructor(address _factory_, address _WETH9_)
        NonfungiblePositionManager(_factory_, _WETH9_, address(0))
    {}

    function name() public view override returns (string memory) {
        return _NAME;
    }

    function symbol() public view override returns (string memory) {
        return _SYMBOL;
    }

    /**
     * @notice Returns an Arcade-hosted JSON metadata URL for the given token.
     *         The frontend renders the SVG + per-position summary server-side
     *         (see /web/app/api/v3-position/[id]/route.tsx).
     */
    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, IERC721Metadata)
        returns (string memory)
    {
        require(_exists(tokenId), "Invalid token ID");
        return string(abi.encodePacked(_TOKEN_URI_BASE, _toDecimal(tokenId)));
    }

    /// @dev Lightweight uint -> decimal ASCII helper. Solidity 0.7 has no
    ///      Strings.toString, so we inline a single allocation conversion.
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
