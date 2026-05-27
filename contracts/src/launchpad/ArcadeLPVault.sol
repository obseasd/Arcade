// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IArcadeV3PositionManager} from "../v3/interfaces/IArcadeV3Minimal.sol";

/**
 * @title ArcadeLPVault
 * @notice Permanently custodies a Uniswap V3 liquidity position (NFT) created
 *         when a launchpad token migrates in "Clanker mode". The vault is
 *         deliberately incapable of removing liquidity: it exposes NO call to
 *         `decreaseLiquidity` or NFT transfer-out, so the principal can never
 *         be rugged. The only value extractable is the swap fees accrued by
 *         the position, which `collectFees` splits between the token creator
 *         and the Arcade treasury (default 80% / 20%).
 *
 *         Anyone may trigger `collectFees` — there's no privileged claimer —
 *         which keeps the position maintenance permissionless and means the
 *         creator always receives their share even if Arcade goes away.
 */
contract ArcadeLPVault is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IArcadeV3PositionManager public immutable positionManager;
    /// @notice The launchpad allowed to register new positions. Set once at
    /// construction. Only it can deposit (so random NFTs can't be parked here).
    address public immutable launchpad;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Default creator share of collected fees (80%). The remainder
    /// (20%) goes to the platform receiver registered with the position.
    uint16 public constant DEFAULT_CREATOR_BPS = 8_000;

    struct VaultedPosition {
        address token0;
        address token1;
        address creator; // receives `creatorBps` of fees
        address platform; // receives the remainder
        uint16 creatorBps;
        bool exists;
    }

    /// tokenId => position metadata
    mapping(uint256 => VaultedPosition) public positions;
    /// list of all custodied tokenIds (for off-chain enumeration)
    uint256[] public allPositions;

    error OnlyLaunchpad();
    error UnknownPosition();
    error AlreadyRegistered();
    error InvalidShare();
    error ZeroAddress();

    event PositionVaulted(
        uint256 indexed tokenId,
        address indexed creator,
        address indexed platform,
        uint16 creatorBps
    );
    event FeesCollected(
        uint256 indexed tokenId,
        uint256 amount0,
        uint256 amount1,
        uint256 creator0,
        uint256 creator1,
        uint256 platform0,
        uint256 platform1
    );

    constructor(IArcadeV3PositionManager positionManager_, address launchpad_) {
        if (address(positionManager_) == address(0) || launchpad_ == address(0)) revert ZeroAddress();
        positionManager = positionManager_;
        launchpad = launchpad_;
    }

    /// @notice Required so the vault can receive the position NFT via safeTransferFrom.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    /**
     * @notice Register a V3 position into the vault. The launchpad must have
     * approved this vault for `tokenId` (or be transferring it directly). The
     * NFT is pulled in and locked forever.
     * @param tokenId the V3 position NFT id (held/approved by the launchpad)
     * @param creator the creator fee receiver
     * @param platform the platform fee receiver (Arcade treasury)
     * @param creatorBps creator's share of fees in bps (e.g. 8000 = 80%)
     */
    function deposit(uint256 tokenId, address creator, address platform, uint16 creatorBps)
        external
        nonReentrant
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (positions[tokenId].exists) revert AlreadyRegistered();
        if (creator == address(0) || platform == address(0)) revert ZeroAddress();
        if (creatorBps > BPS_DENOMINATOR) revert InvalidShare();

        // Pull the NFT in. Launchpad must have approved the vault first.
        positionManager.safeTransferFrom(msg.sender, address(this), tokenId);

        (, , address token0, address token1, , , , , , , , ) = positionManager.positions(tokenId);

        positions[tokenId] = VaultedPosition({
            token0: token0,
            token1: token1,
            creator: creator,
            platform: platform,
            creatorBps: creatorBps,
            exists: true
        });
        allPositions.push(tokenId);

        emit PositionVaulted(tokenId, creator, platform, creatorBps);
    }

    /**
     * @notice Collect accrued swap fees for a vaulted position and split them
     * between the creator and the platform. Permissionless: anyone can poke it
     * (fees still go only to the registered receivers). Never touches principal.
     */
    function collectFees(uint256 tokenId)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        VaultedPosition memory p = positions[tokenId];
        if (!p.exists) revert UnknownPosition();

        // Collect ALL owed fees to this vault. type(uint128).max means "all".
        (amount0, amount1) = positionManager.collect(
            IArcadeV3PositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        (uint256 c0, uint256 pf0) = _split(amount0, p.creatorBps);
        (uint256 c1, uint256 pf1) = _split(amount1, p.creatorBps);

        if (c0 > 0) IERC20(p.token0).safeTransfer(p.creator, c0);
        if (pf0 > 0) IERC20(p.token0).safeTransfer(p.platform, pf0);
        if (c1 > 0) IERC20(p.token1).safeTransfer(p.creator, c1);
        if (pf1 > 0) IERC20(p.token1).safeTransfer(p.platform, pf1);

        emit FeesCollected(tokenId, amount0, amount1, c0, c1, pf0, pf1);
    }

    /// @dev Splits `amount` into (creatorCut, platformCut) by `creatorBps`.
    function _split(uint256 amount, uint16 creatorBps)
        internal
        pure
        returns (uint256 creatorCut, uint256 platformCut)
    {
        if (amount == 0) return (0, 0);
        creatorCut = (amount * creatorBps) / BPS_DENOMINATOR;
        platformCut = amount - creatorCut;
    }

    // ====================== Views ======================

    function positionsCount() external view returns (uint256) {
        return allPositions.length;
    }

    function getPosition(uint256 tokenId) external view returns (VaultedPosition memory) {
        return positions[tokenId];
    }
}
