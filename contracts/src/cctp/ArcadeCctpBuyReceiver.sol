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

/**
 * @title ArcadeCctpBuyReceiver
 * @notice "Bridge and buy" landing contract on Arc. A user on another chain
 *         calls CCTP V2 `depositForBurnWithHook` with:
 *           - mintRecipient = this contract
 *           - hookData      = abi.encode(address beneficiary, address token, uint256 minTokensOut)
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

    // Byte offsets of fields inside the full CCTP V2 `message`.
    uint256 private constant MINT_RECIPIENT_OFFSET = 184; // body(148) + 36
    uint256 private constant HOOK_DATA_OFFSET = 376; // body(148) + 228
    // hookData = abi.encode(address beneficiary, address token, uint256 minOut,
    // address ammRouter) = 4 * 32 bytes. ammRouter lets the frontend pick the
    // best V2-style venue (Arcade V2 / XyloNet / ...); 0 uses the default.
    uint256 private constant HOOK_DATA_LEN = 128;

    event BridgeBuy(
        address indexed beneficiary,
        address indexed token,
        uint256 usdcMinted,
        uint256 tokensOut,
        bool bought
    );

    error BadMessage();
    error NotForThisReceiver();
    error NothingMinted();

    constructor(
        address _messageTransmitter,
        address _usdc,
        address _launchpad,
        address _v2Router
    ) {
        require(
            _messageTransmitter != address(0) &&
                _usdc != address(0) &&
                _launchpad != address(0) &&
                _v2Router != address(0),
            "zero addr"
        );
        messageTransmitter = IMessageTransmitterV2(_messageTransmitter);
        usdc = IERC20(_usdc);
        launchpad = _launchpad;
        v2Router = _v2Router;
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
        if (message.length < HOOK_DATA_OFFSET + HOOK_DATA_LEN) revert BadMessage();

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
            address ammRouter
        ) = abi.decode(
                message[HOOK_DATA_OFFSET:HOOK_DATA_OFFSET + HOOK_DATA_LEN],
                (address, address, uint256, address)
            );
        if (beneficiary == address(0) || token == address(0)) revert BadMessage();
        // Frontend-chosen V2-style venue (best route); fall back to the default.
        address router = ammRouter == address(0) ? v2Router : ammRouter;

        uint256 balBefore = usdc.balanceOf(address(this));
        // Mints USDC to this contract (mintRecipient). Reverts if already used.
        messageTransmitter.receiveMessage(message, attestation);
        uint256 minted = usdc.balanceOf(address(this)) - balBefore;
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

        // Route 2: AMM. Swap USDC -> token via the frontend-chosen V2-style
        // router (best route: XyloNet stable pool for EURC, Arcade V2 for
        // migrated launches, ...), delivered straight to the beneficiary.
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

        // Both routes failed — return the bridged USDC so funds are never stuck.
        usdc.safeTransfer(beneficiary, minted);
        emit BridgeBuy(beneficiary, token, minted, 0, false);
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
