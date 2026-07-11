// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ArcadeIncentiveDistributor
/// @notice On-chain, escrow-backed liquidity-incentive campaigns (Merkl-style).
///
///         Flow:
///           1. Anyone `createCampaign`s: they pick a pool + reward token +
///              amount + window, and the FULL reward amount is pulled into
///              escrow up front. A campaign is therefore always fully funded
///              the moment it exists (no "promise to pay later").
///           2. Off-chain, an indexer/keeper reads the pool's LP events over
///              the window, computes each LP's pro-rata share, and the trusted
///              `operator` posts a cumulative Merkle root per epoch via
///              `setRoot`. Cumulative == each leaf is the TOTAL owed to that
///              account so far, so a fresh root simply supersedes the old one.
///           3. LPs `claim(id, account, cumulative, proof)` and receive the
///              delta between their leaf and what they've already pulled.
///           4. After the window + a grace delay the creator `reclaim`s any
///              rewards that were never distributed.
///
///         Trust model: `operator` is trusted to post honest roots (same
///         posture as the compounder backend / twitter signer on testnet;
///         a multisig for mainnet). Even a buggy or malicious root can NEVER
///         pay out more than a campaign's own escrowed `total` — `distributed`
///         is checked against `total` on every claim — so the blast radius is
///         bounded to funds that campaign's creator already committed.
///
///         Cross-campaign isolation: every campaign sharing a reward token
///         holds ONE commingled ERC20 balance, so solvency relies on the
///         invariant "tokens leaving for campaign i (claims + reclaim) never
///         exceed total_i". `reclaim` sweeps the remainder WITHOUT advancing
///         `distributed`, so it MUST also close the campaign to further claims
///         or a stale-but-valid proof would draw from a sibling's escrow. Two
///         locks enforce that: `claim` reverts once `reclaimed`, and `reclaim`
///         also zeroes `root`. The RECLAIM_DELAY grace after `end` is the
///         window for LPs to claim before the sweep. (Audit 2026-07 H-1.)
///
///         Known, in-model operational caveats (NOT solvency bugs):
///           - If the operator posts a root whose leaves sum to MORE than the
///             escrow, claims are first-come-first-served until `total` is
///             exhausted; late claimers hit ExceedsEscrow. Keep the leaf sum
///             <= total off-chain when building roots.
///           - Rebasing-DOWN reward tokens can shrink the commingled balance
///             below outstanding obligations. Do not run campaigns with them.
///
///         Leaf encoding matches OpenZeppelin's StandardMerkleTree (the JS
///         openzeppelin merkle-tree package): the leaf is double-hashed
///         `keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))))`
///         so the operator can build proofs with the audited library directly.
contract ArcadeIncentiveDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Campaign {
        address creator; // who funded + can reclaim the remainder
        address pool; // the LP pool being incentivised (informational / for the indexer)
        address rewardToken; // token paid out
        uint256 total; // amount escrowed at creation
        uint256 distributed; // amount already claimed (<= total, always)
        uint64 start; // campaign window start (unix)
        uint64 end; // campaign window end (unix)
        bytes32 root; // current cumulative Merkle root (0 until first setRoot)
        bool reclaimed; // creator pulled the unspent remainder
    }

    /// @notice Grace period after `end` before the creator may reclaim unspent
    ///         rewards. Gives the operator time to post the final epoch root so
    ///         the last window of LPs can still claim before funds are pulled.
    uint64 public constant RECLAIM_DELAY = 3 days;

    /// @notice Address allowed to post cumulative Merkle roots.
    address public operator;

    Campaign[] private _campaigns;

    /// @notice campaignId => account => cumulative amount already claimed.
    mapping(uint256 => mapping(address => uint256)) public claimed;

    event OperatorChanged(address indexed previous, address indexed current);
    event CampaignCreated(
        uint256 indexed id,
        address indexed creator,
        address indexed pool,
        address rewardToken,
        uint256 amount,
        uint64 start,
        uint64 end
    );
    event RootUpdated(uint256 indexed id, bytes32 root);
    event Claimed(uint256 indexed id, address indexed account, uint256 amount);
    event Reclaimed(uint256 indexed id, address indexed creator, uint256 amount);

    error NotOperator();
    error BadWindow();
    error ZeroAmount();
    error ZeroAddress();
    error UnknownCampaign();
    error NothingToClaim();
    error InvalidProof();
    error ExceedsEscrow();
    error TooEarlyToReclaim();
    error AlreadyReclaimed();
    error CampaignClosed();
    error NotCreator();

    constructor(address _operator) Ownable(msg.sender) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
        emit OperatorChanged(address(0), _operator);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Rotate the root-posting operator (owner only).
    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        emit OperatorChanged(operator, _operator);
        operator = _operator;
    }

    // ------------------------------------------------------------------
    // Campaign lifecycle
    // ------------------------------------------------------------------

    /// @notice Create + fully fund an incentive campaign. Pulls `amount` of
    ///         `rewardToken` from the caller into escrow. Fee-on-transfer
    ///         tokens are supported: whatever actually lands is escrowed.
    /// @return id the new campaign id.
    function createCampaign(
        address pool,
        address rewardToken,
        uint256 amount,
        uint64 start,
        uint64 end
    ) external nonReentrant returns (uint256 id) {
        if (rewardToken == address(0) || pool == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        // end must be in the future and after start; start may be <= now (a
        // campaign that has already "opened" is fine, it just means rewards
        // accrue from now).
        if (end <= start || end <= block.timestamp) revert BadWindow();

        // Escrow up front; measure the delta so fee-on-transfer tokens escrow
        // the true received amount rather than the requested one.
        IERC20 token = IERC20(rewardToken);
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroAmount();

        id = _campaigns.length;
        _campaigns.push(
            Campaign({
                creator: msg.sender,
                pool: pool,
                rewardToken: rewardToken,
                total: received,
                distributed: 0,
                start: start,
                end: end,
                root: bytes32(0),
                reclaimed: false
            })
        );

        emit CampaignCreated(id, msg.sender, pool, rewardToken, received, start, end);
    }

    /// @notice Post the current cumulative Merkle root for a campaign
    ///         (operator only). Each leaf is the TOTAL owed to an account since
    ///         the campaign started, so a new root supersedes the previous one.
    function setRoot(uint256 id, bytes32 root) external onlyOperator {
        if (id >= _campaigns.length) revert UnknownCampaign();
        _campaigns[id].root = root;
        emit RootUpdated(id, root);
    }

    /// @notice Claim rewards for `account` up to the signed cumulative amount.
    ///         Anyone may submit (the payout always goes to `account`), so a
    ///         keeper can batch-claim on users' behalf. Pays the delta between
    ///         the proven cumulative and what `account` has already claimed.
    function claim(
        uint256 id,
        address account,
        uint256 cumulativeAmount,
        bytes32[] calldata proof
    ) external nonReentrant {
        if (id >= _campaigns.length) revert UnknownCampaign();
        Campaign storage c = _campaigns[id];

        // Once the creator has reclaimed the remainder, the campaign is closed:
        // its unspent escrow has physically left the contract, so honouring a
        // late proof here would pay out of a DIFFERENT campaign's commingled
        // balance (all campaigns sharing a reward token hold one pooled ERC20
        // balance). Claims must therefore close exactly when reclaim opens, and
        // the RECLAIM_DELAY grace after `end` is the window to get them in.
        if (c.reclaimed) revert CampaignClosed();

        // Double-hashed leaf, matching OZ StandardMerkleTree.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, c.root, leaf)) revert InvalidProof();

        uint256 already = claimed[id][account];
        if (cumulativeAmount <= already) revert NothingToClaim();
        uint256 payout = cumulativeAmount - already;

        // Hard cap: a campaign can never pay out more than it escrowed, no
        // matter what root the operator posts. Bounds the blast radius.
        if (c.distributed + payout > c.total) revert ExceedsEscrow();

        claimed[id][account] = cumulativeAmount;
        c.distributed += payout;

        IERC20(c.rewardToken).safeTransfer(account, payout);
        emit Claimed(id, account, payout);
    }

    /// @notice After the window + grace delay, the creator reclaims whatever
    ///         was never distributed.
    function reclaim(uint256 id) external nonReentrant {
        if (id >= _campaigns.length) revert UnknownCampaign();
        Campaign storage c = _campaigns[id];
        if (msg.sender != c.creator) revert NotCreator();
        if (c.reclaimed) revert AlreadyReclaimed();
        if (block.timestamp < uint256(c.end) + RECLAIM_DELAY) revert TooEarlyToReclaim();

        uint256 remainder = c.total - c.distributed;
        c.reclaimed = true;
        // Defense-in-depth: also drop the root so no leaf can ever verify after
        // the escrow has been swept, even if a future refactor forgot the
        // `reclaimed` guard in claim().
        c.root = bytes32(0);
        if (remainder > 0) {
            IERC20(c.rewardToken).safeTransfer(c.creator, remainder);
        }
        emit Reclaimed(id, c.creator, remainder);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    function campaigns(uint256 id) external view returns (Campaign memory) {
        if (id >= _campaigns.length) revert UnknownCampaign();
        return _campaigns[id];
    }

    /// @notice How much `account` can still pull given a proven cumulative.
    ///         Pure helper for the frontend; does not verify the proof.
    function claimable(uint256 id, address account, uint256 cumulativeAmount)
        external
        view
        returns (uint256)
    {
        uint256 already = claimed[id][account];
        return cumulativeAmount > already ? cumulativeAmount - already : 0;
    }
}
