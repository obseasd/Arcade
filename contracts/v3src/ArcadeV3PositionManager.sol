// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-periphery/contracts/NonfungiblePositionManager.sol";

// ArcadeV3PositionManager - Arcade-branded fork of Uniswap V3's canonical
// NonfungiblePositionManager. Inherits behaviour 1:1 so the standard
// INonfungiblePositionManager interface is preserved (Revert, Arrakis,
// Gamma, lending markets that take V3 NFTs as collateral plug in with no
// glue). Only name() and symbol() are overridden; the per-token URL is
// routed through the constructor's _tokenDescriptor_ slot, which is the
// standard NPM extension point (see ArcadeV3PositionDescriptor).
//
// IMPORTANT caveat for the v1 audit: the inherited ERC721Permit constructor
// pins the EIP-712 nameHash to the literal "Uniswap V3 Positions NFT-V1".
// Permit signatures therefore still verify against the Uniswap domain even
// though name() reads as Arcade. Cross-tool compatibility holds because
// signers read name() at runtime. Forking ERC721Permit to flip the domain
// hash is deferred to v2.
contract ArcadeV3PositionManager is NonfungiblePositionManager {
    // Arcade-branded display strings returned by the ERC-721 metadata view
    // functions. name()/symbol() in OZ 3.x ERC721 are declared virtual, so
    // we can safely override them - tokenURI() in the parent NPM is not
    // virtual and therefore routes through the descriptor slot instead.
    string private constant _NAME = "Arcade V3 Positions NFT-V1";
    string private constant _SYMBOL = "ARC-V3-POS";

    constructor(
        address _factory_,
        address _WETH9_,
        address _tokenDescriptor_
    )
        NonfungiblePositionManager(_factory_, _WETH9_, _tokenDescriptor_)
    {}

    function name() public view override returns (string memory) {
        return _NAME;
    }

    function symbol() public view override returns (string memory) {
        return _SYMBOL;
    }
}
