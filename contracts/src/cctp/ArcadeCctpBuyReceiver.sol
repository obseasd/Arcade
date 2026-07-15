// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation)
        external
        returns (bool);
}

interface IArcadeLaunchpadBuy {
    /// @return tokensOut actual tokens delivered to msg.sender
    /// @return usdcSpent actual gross USDC spent
    /// @return refund USDC returned to msg.sender (curve near migration)
    function buy(address tokenAddr, uint256 amountUsdcIn, uint256 minTokensOut)
        external
        returns (uint256 tokensOut, uint256 usdcSpent, uint256 refund);
}

interface IV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// Arcade's V3 router uses a FLAT-parameter exactInputSingle (not the canonical
/// Uniswap struct) with no sqrtPriceLimit. This is the venue for the USDC/ETH
/// (SeedETH) pool, which only exists on the V3 factory.
interface IArcadeV3Router {
    function exactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external returns (uint256 amountOut);
}

/**
 * @title ArcadeCctpBuyReceiver
 * @notice "Bridge and buy" landing contract on Arc. A user on another chain
 *         calls CCTP V2 `depositForBurnWithHook` with:
 *           - mintRecipient = this contract
 *           - hookData      = abi.encode(beneficiary, token, minTokensOut,
 *                             ammRouter, v3Router, v3Fee)
 *         Then ANYONE (the user, the app, a relayer) calls `receiveAndBuy` on
 *         Arc with the attested message. In one atomic tx this contract:
 *           1. calls MessageTransmitterV2.receiveMessage -> USDC is minted here,
 *           2. reads the ATTESTED hookData to learn (beneficiary, token, minOut),
 *           3. buys `token` on the launchpad curve with the freshly minted USDC,
 *           4. forwards the bought tokens (and any curve refund) to `beneficiary`.
 *         If the buy reverts (token migrated, slippage, unknown token, ...), the
 *         minted USDC is returned to `beneficiary` so funds are never stuck.
 *
 * @dev Trustless recipient: `beneficiary` is read from the ATTESTED message, not
 *      from the caller, so `receiveAndBuy` is safe to leave permissionless — a
 *      third party can only ever execute the depositor's own committed intent,
 *      never redirect the tokens. The contract holds no funds between calls.
 *
 *      CCTP V2 message layout (verified against circlefin/evm-cctp-contracts):
 *        MessageV2 body starts at byte 148. Within the BurnMessageV2 body:
 *        mintRecipient at byte 36, hookData at byte 228. So in the full
 *        `message`: mintRecipient at byte 184, hookData at byte 376.
 */
contract ArcadeCctpBuyReceiver is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IMessageTransmitterV2 public immutable messageTransmitter;
    IERC20 public immutable usdc;
    address public immutable launchpad;
    /// V2 router used as an AMM fallback when the token isn't a live curve
    /// token (migrated launch, cirBTC, EURC, any USDC-paired token).
    address public immutable v2Router;
    /// Receives the bridge fee. Immutable so a compromised key can never
    /// redirect it; a new treasury means a new receiver.
    address public immutable treasury;

    /// @notice Target ALL-IN bridge cost, in bps of the burned amount, for a
    ///         FAST transfer. Circle's own fast fee is deducted at mint (it is
    ///         attested in the message as `feeExecuted`), so we only skim the
    ///         REMAINDER up to this target: fee = amount*5/10000 - feeExecuted.
    ///         Net effect: the user always pays ~0.05% total no matter what
    ///         Circle charges on that route (0.01% ETH, 0.013% Base/Arb today),
    ///         and if Circle ever raises its fee past the target we skim zero
    ///         rather than exceeding it. STANDARD transfers are never charged.
    uint256 private constant TARGET_BRIDGE_FEE_BPS = 5;
    /// CCTP's fast/standard boundary: minFinalityThreshold <= 1000 is Fast.
    uint32 private constant FAST_FINALITY_MAX = 1000;

    // Byte offsets of fields inside the full CCTP V2 `message`.
    // MessageV2 header is 148 bytes; BurnMessageV2 body then lays out
    // version(4) burnToken(32) mintRecipient(32) amount(32) messageSender(32)
    // maxFee(32) feeExecuted(32) expirationBlock(32) hookData(...).
    uint256 private constant FINALITY_EXECUTED_OFFSET = 144; // header, uint32
    uint256 private constant MINT_RECIPIENT_OFFSET = 184; // body(148) + 36
    uint256 private constant AMOUNT_OFFSET = 216; // body(148) + 68
    uint256 private constant FEE_EXECUTED_OFFSET = 312; // body(148) + 164
    uint256 private constant HOOK_DATA_OFFSET = 376; // body(148) + 228
    // hookData = abi.encode(address beneficiary, address token, uint256 minOut,
    // address ammRouter, address v3Router, uint256 v3Fee) = 6 * 32 bytes.
    //   - ammRouter: best V2-style venue (Arcade V2 / XyloNet / ...).
    //   - v3Router + v3Fee: when BOTH non-zero, the AMM leg routes through the
    //     Arcade V3 router at that fee tier instead of V2 (the only venue for
    //     the USDC/ETH pool). The frontend picks exactly ONE AMM venue.
    uint256 private constant HOOK_DATA_LEN = 192;

    event BridgeBuy(
        address indexed beneficiary,
        address indexed token,
        uint256 usdcMinted,
        uint256 tokensOut,
        bool bought
    );
    /// Fast-transfer bridge fee skimmed to the treasury.
    event BridgeFeeTaken(uint256 fee);
    /// Plain bridge (no buy) forwarded to the beneficiary, net of the fee.
    event BridgeForward(address indexed beneficiary, uint256 usdcOut);

    error BadMessage();
    error NotForThisReceiver();
    error NothingMinted();

    constructor(
        address _messageTransmitter,
        address _usdc,
        address _launchpad,
        address _v2Router,
        address _treasury
    ) {
        require(
            _messageTransmitter != address(0) &&
                _usdc != address(0) &&
                _launchpad != address(0) &&
                _v2Router != address(0) &&
                _treasury != address(0),
            "zero addr"
        );
        messageTransmitter = IMessageTransmitterV2(_messageTransmitter);
        usdc = IERC20(_usdc);
        launchpad = _launchpad;
        v2Router = _v2Router;
        treasury = _treasury;
    }

    /// @dev Bridge fee for this message, derived ENTIRELY from Circle-attested
    ///      fields so the sender cannot understate it: the burned `amount`, the
    ///      `feeExecuted` Circle actually took, and the executed finality
    ///      threshold. Returns 0 for a standard transfer, and 0 if Circle's own
    ///      fee already meets/exceeds the all-in target.
    function _bridgeFee(bytes calldata message, uint256 minted)
        private
        pure
        returns (uint256 fee)
    {
        uint32 finalityExecuted = uint32(
            uint256(_loadWord(message, FINALITY_EXECUTED_OFFSET)) >> 224
        );
        // Standard transfer: Circle charges nothing and neither do we.
        if (finalityExecuted > FAST_FINALITY_MAX) return 0;

        uint256 amount = uint256(_loadWord(message, AMOUNT_OFFSET));
        uint256 feeExecuted = uint256(_loadWord(message, FEE_EXECUTED_OFFSET));

        uint256 target = (amount * TARGET_BRIDGE_FEE_BPS) / 10_000;
        if (feeExecuted >= target) return 0;
        fee = target - feeExecuted;
        // Never skim more than actually landed (defensive; cannot happen with
        // sane values since minted == amount - feeExecuted).
        if (fee > minted) fee = minted;
    }

    /**
     * @notice Redeem an attested CCTP transfer and buy the committed token.
     * @param message     the CCTP V2 message (mintRecipient must be this contract)
     * @param attestation Circle's attestation for `message`
     */
    function receiveAndBuy(bytes calldata message, bytes calldata attestation)
        external
        nonReentrant
    {
        // EXACT length, mirroring receiveAndForward (audit 2026-07-11 F-2).
        if (message.length != HOOK_DATA_OFFSET + HOOK_DATA_LEN) revert BadMessage();

        // This message must mint to us, else `minted` below would be 0 anyway,
        // but check explicitly so a mis-addressed message fails loudly.
        address mintRecipient = address(
            uint160(uint256(_loadWord(message, MINT_RECIPIENT_OFFSET)))
        );
        if (mintRecipient != address(this)) revert NotForThisReceiver();

        // Attested intent — cannot be forged by the caller.
        (
            address beneficiary,
            address token,
            uint256 minTokensOut,
            address ammRouter,
            address v3Router,
            uint256 v3Fee
        ) = abi.decode(
                message[HOOK_DATA_OFFSET:HOOK_DATA_OFFSET + HOOK_DATA_LEN],
                (address, address, uint256, address, address, uint256)
            );
        if (beneficiary == address(0) || token == address(0)) revert BadMessage();
        // Frontend-chosen V2-style venue (best route); fall back to the default.
        address router = ammRouter == address(0) ? v2Router : ammRouter;
        bool useV3 = v3Router != address(0) && v3Fee != 0;

        uint256 balBefore = usdc.balanceOf(address(this));
        // Mints USDC to this contract (mintRecipient). Reverts if already used.
        messageTransmitter.receiveMessage(message, attestation);
        uint256 minted = usdc.balanceOf(address(this)) - balBefore;
        if (minted == 0) revert NothingMinted();

        // Skim the fast-transfer bridge fee before anything else, so the buy
        // and every refund path below operate on the net amount.
        minted -= _takeBridgeFee(message, minted);
        if (minted == 0) revert NothingMinted();

        // Route 1: the bonding-curve launchpad (works only for a live,
        // non-migrated curve token).
        usdc.forceApprove(launchpad, minted);
        try IArcadeLaunchpadBuy(launchpad).buy(token, minted, minTokensOut) returns (
            uint256 tokensOut,
            uint256,
            uint256
        ) {
            if (tokensOut > 0) {
                IERC20(token).safeTransfer(beneficiary, tokensOut);
            }
            // Any USDC this flow left behind (curve refund near migration) goes
            // to the beneficiary. Uses balBefore as the baseline so a pre-
            // existing stuck balance is never swept into this transfer.
            uint256 leftover = usdc.balanceOf(address(this)) - balBefore;
            if (leftover > 0) usdc.safeTransfer(beneficiary, leftover);
            usdc.forceApprove(launchpad, 0);
            emit BridgeBuy(beneficiary, token, minted, tokensOut, true);
            return;
        } catch {
            // Not a live curve token (migrated / cirBTC / EURC / unknown) — fall
            // through to the AMM.
            usdc.forceApprove(launchpad, 0);
        }

        // Route 2: AMM. Exactly ONE venue, chosen by the frontend, delivered
        // straight to the beneficiary.
        if (useV3) {
            // V3: USDC -> token via the Arcade V3 router at the chosen fee tier.
            // This is the only venue for the USDC/ETH (SeedETH) pool.
            usdc.forceApprove(v3Router, minted);
            try
                IArcadeV3Router(v3Router).exactInputSingle(
                    address(usdc),
                    token,
                    uint24(v3Fee),
                    beneficiary,
                    minted,
                    minTokensOut,
                    block.timestamp
                )
            returns (uint256 amountOut) {
                usdc.forceApprove(v3Router, 0);
                emit BridgeBuy(beneficiary, token, minted, amountOut, true);
                return;
            } catch {
                usdc.forceApprove(v3Router, 0);
            }
        } else {
            // V2: USDC -> token via the frontend-chosen V2-style router
            // (XyloNet stable pool for EURC, Arcade V2 for migrated launches).
            usdc.forceApprove(router, minted);
            address[] memory path = new address[](2);
            path[0] = address(usdc);
            path[1] = token;
            try
                IV2Router(router).swapExactTokensForTokens(
                    minted,
                    minTokensOut,
                    path,
                    beneficiary,
                    block.timestamp
                )
            returns (uint256[] memory amounts) {
                usdc.forceApprove(router, 0);
                emit BridgeBuy(
                    beneficiary,
                    token,
                    minted,
                    amounts.length > 0 ? amounts[amounts.length - 1] : 0,
                    true
                );
                return;
            } catch {
                usdc.forceApprove(router, 0);
            }
        }

        // Both routes failed — return the bridged USDC so funds are never stuck.
        usdc.safeTransfer(beneficiary, minted);
        emit BridgeBuy(beneficiary, token, minted, 0, false);
    }

    /// @dev Compute + transfer the bridge fee. Returns the amount skimmed.
    function _takeBridgeFee(bytes calldata message, uint256 minted)
        private
        returns (uint256 fee)
    {
        fee = _bridgeFee(message, minted);
        if (fee > 0) {
            usdc.safeTransfer(treasury, fee);
            emit BridgeFeeTaken(fee);
        }
    }

    /**
     * @notice Redeem an attested CCTP transfer WITHOUT buying: skim the
     *         fast-transfer bridge fee and forward the rest to the beneficiary.
     *         This is the plain-bridge path. hookData carries only the
     *         beneficiary (32 bytes), since there is no token/route to commit.
     * @dev Same trustless property as receiveAndBuy: the beneficiary comes from
     *      the ATTESTED message, so this is safe to leave permissionless.
     */
    function receiveAndForward(bytes calldata message, bytes calldata attestation)
        external
        nonReentrant
    {
        // EXACT length (audit 2026-07-11 F-2): a `>=` here also accepts a
        // 568-byte BUY message, whose first hookData word decodes as the
        // beneficiary, so funds are not misrouted but the committed buy is
        // silently skipped. Anyone could front-run receiveAndBuy with this and
        // cancel the user's buy (nonce burned, plain USDC delivered instead).
        // Exact lengths make the two entrypoints mutually exclusive.
        if (message.length != HOOK_DATA_OFFSET + 32) revert BadMessage();

        address mintRecipient = address(
            uint160(uint256(_loadWord(message, MINT_RECIPIENT_OFFSET)))
        );
        if (mintRecipient != address(this)) revert NotForThisReceiver();

        address beneficiary = address(
            uint160(uint256(_loadWord(message, HOOK_DATA_OFFSET)))
        );
        if (beneficiary == address(0)) revert BadMessage();

        uint256 balBefore = usdc.balanceOf(address(this));
        messageTransmitter.receiveMessage(message, attestation);
        uint256 minted = usdc.balanceOf(address(this)) - balBefore;
        if (minted == 0) revert NothingMinted();

        minted -= _takeBridgeFee(message, minted);
        if (minted > 0) usdc.safeTransfer(beneficiary, minted);
        emit BridgeForward(beneficiary, minted);
    }

    /// @dev Read a 32-byte word at `offset` inside the `message` calldata bytes.
    function _loadWord(bytes calldata message, uint256 offset)
        private
        pure
        returns (bytes32 v)
    {
        assembly {
            v := calldataload(add(message.offset, offset))
        }
    }
}
