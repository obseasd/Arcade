// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IArcadeV3PositionManager} from "../../src/v3/interfaces/IArcadeV3Minimal.sol";

/**
 * @notice Minimal stand-in for Uniswap V3's NonfungiblePositionManager, just
 * enough to exercise ArcadeLPVault without the full V3 stack. Tracks NFT
 * ownership, lets a test stage "owed fees" per position, and pays them out
 * (from a pre-funded balance) on `collect`.
 */
contract MockV3PositionManager is IArcadeV3PositionManager {
    using SafeERC20 for IERC20;

    struct Pos {
        address token0;
        address token1;
        uint128 owed0;
        uint128 owed1;
    }

    mapping(uint256 => Pos) public pos;
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public approvals;
    uint256 public nextId = 1;

    /// @notice Test helper: mint a position NFT to `to` for a token pair.
    function testMint(address to, address token0, address token1) external returns (uint256 id) {
        id = nextId++;
        pos[id] = Pos({token0: token0, token1: token1, owed0: 0, owed1: 0});
        owners[id] = to;
    }

    /// @notice Test helper: stage fees owed to a position and fund this contract.
    function testAccrueFees(uint256 id, uint128 amount0, uint128 amount1) external {
        pos[id].owed0 += amount0;
        pos[id].owed1 += amount1;
    }

    // --- IArcadeV3PositionManager ---

    function factory() external pure returns (address) {
        return address(0);
    }

    function createAndInitializePoolIfNecessary(address, address, uint24, uint160)
        external
        payable
        returns (address)
    {
        return address(0);
    }

    function mint(MintParams calldata)
        external
        payable
        returns (uint256, uint128, uint256, uint256)
    {
        revert("not used in mock");
    }

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        Pos storage p = pos[params.tokenId];
        amount0 = p.owed0;
        amount1 = p.owed1;
        p.owed0 = 0;
        p.owed1 = 0;
        if (amount0 > 0) IERC20(p.token0).safeTransfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransfer(params.recipient, amount1);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96,
            address,
            address token0,
            address token1,
            uint24,
            int24,
            int24,
            uint128,
            uint256,
            uint256,
            uint128,
            uint128
        )
    {
        Pos memory p = pos[tokenId];
        return (0, address(0), p.token0, p.token1, 0, 0, 0, 0, 0, 0, p.owed0, p.owed1);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(
            owners[tokenId] == from && (msg.sender == from || approvals[tokenId] == msg.sender),
            "not owner/approved"
        );
        owners[tokenId] = to;
        approvals[tokenId] = address(0);
        // Fire the receiver hook like the real NFT would.
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, "")
                    == IERC721Receiver.onERC721Received.selector,
                "bad receiver"
            );
        }
    }

    function approve(address to, uint256 tokenId) external {
        require(owners[tokenId] == msg.sender, "not owner");
        approvals[tokenId] = to;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }
}
