// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ArcadeIncentiveDistributor} from "../src/incentive/ArcadeIncentiveDistributor.sol";

contract MintableERC20 is ERC20 {
    constructor() ERC20("Reward", "RWD") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract ArcadeIncentiveDistributorTest is Test {
    ArcadeIncentiveDistributor dist;
    MintableERC20 reward;

    address owner = address(this);
    address operator;
    address creator;
    address pool;
    address alice;
    address bob;

    uint64 start;
    uint64 end;

    function setUp() public {
        operator = makeAddr("operator");
        creator = makeAddr("creator");
        pool = makeAddr("pool");
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        reward = new MintableERC20();
        dist = new ArcadeIncentiveDistributor(operator);

        start = uint64(block.timestamp);
        end = uint64(block.timestamp + 7 days);

        reward.mint(creator, 1_000_000e18);
    }

    // --- helpers -------------------------------------------------------

    function _leaf(address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// Build a 2-leaf StandardMerkleTree; return (root, proofForA, proofForB).
    function _tree(
        address a,
        uint256 amtA,
        address b,
        uint256 amtB
    ) internal pure returns (bytes32 root, bytes32[] memory proofA, bytes32[] memory proofB) {
        bytes32 la = _leaf(a, amtA);
        bytes32 lb = _leaf(b, amtB);
        root = _hashPair(la, lb);
        proofA = new bytes32[](1);
        proofA[0] = lb;
        proofB = new bytes32[](1);
        proofB[0] = la;
    }

    function _createFundedCampaign(uint256 amount) internal returns (uint256 id) {
        vm.startPrank(creator);
        reward.approve(address(dist), amount);
        id = dist.createCampaign(pool, address(reward), amount, start, end);
        vm.stopPrank();
    }

    // --- creation ------------------------------------------------------

    function test_createCampaign_escrowsFunds() public {
        uint256 id = _createFundedCampaign(100_000e18);
        assertEq(id, 0);
        assertEq(reward.balanceOf(address(dist)), 100_000e18);
        ArcadeIncentiveDistributor.Campaign memory c = dist.campaigns(0);
        assertEq(c.creator, creator);
        assertEq(c.total, 100_000e18);
        assertEq(c.distributed, 0);
        assertEq(dist.campaignCount(), 1);
    }

    function test_createCampaign_revertsOnBadWindow() public {
        vm.startPrank(creator);
        reward.approve(address(dist), 1e18);
        vm.expectRevert(ArcadeIncentiveDistributor.BadWindow.selector);
        dist.createCampaign(pool, address(reward), 1e18, end, start); // end <= start
        vm.stopPrank();
    }

    function test_createCampaign_revertsOnZeroAmount() public {
        vm.startPrank(creator);
        vm.expectRevert(ArcadeIncentiveDistributor.ZeroAmount.selector);
        dist.createCampaign(pool, address(reward), 0, start, end);
        vm.stopPrank();
    }

    // --- root + claim --------------------------------------------------

    function test_claim_paysDeltaCumulative() public {
        uint256 id = _createFundedCampaign(100_000e18);

        // Epoch 1: alice owed 10k, bob owed 5k.
        (bytes32 root1, bytes32[] memory pA1, bytes32[] memory pB1) =
            _tree(alice, 10_000e18, bob, 5_000e18);
        vm.prank(operator);
        dist.setRoot(id, root1);

        vm.prank(alice);
        dist.claim(id, alice, 10_000e18, pA1);
        assertEq(reward.balanceOf(alice), 10_000e18);
        assertEq(dist.claimed(id, alice), 10_000e18);

        // Epoch 2: alice cumulative rises to 25k, bob to 8k. Alice pulls delta.
        (bytes32 root2, bytes32[] memory pA2, bytes32[] memory pB2) =
            _tree(alice, 25_000e18, bob, 8_000e18);
        vm.prank(operator);
        dist.setRoot(id, root2);

        vm.prank(alice);
        dist.claim(id, alice, 25_000e18, pA2);
        assertEq(reward.balanceOf(alice), 25_000e18); // total, not 25k+10k

        // Bob claims his cumulative in one go.
        vm.prank(bob);
        dist.claim(id, bob, 8_000e18, pB2);
        assertEq(reward.balanceOf(bob), 8_000e18);

        ArcadeIncentiveDistributor.Campaign memory c = dist.campaigns(id);
        assertEq(c.distributed, 33_000e18);
    }

    function test_claim_revertsOnReplay() public {
        uint256 id = _createFundedCampaign(100_000e18);
        (bytes32 root, bytes32[] memory pA,) = _tree(alice, 10_000e18, bob, 5_000e18);
        vm.prank(operator);
        dist.setRoot(id, root);

        vm.prank(alice);
        dist.claim(id, alice, 10_000e18, pA);
        // Second claim at the same cumulative pays nothing.
        vm.prank(alice);
        vm.expectRevert(ArcadeIncentiveDistributor.NothingToClaim.selector);
        dist.claim(id, alice, 10_000e18, pA);
    }

    function test_claim_revertsOnForgedProof() public {
        uint256 id = _createFundedCampaign(100_000e18);
        (bytes32 root, bytes32[] memory pA,) = _tree(alice, 10_000e18, bob, 5_000e18);
        vm.prank(operator);
        dist.setRoot(id, root);

        // Alice tries to claim more than her leaf says.
        vm.prank(alice);
        vm.expectRevert(ArcadeIncentiveDistributor.InvalidProof.selector);
        dist.claim(id, alice, 999_999e18, pA);
    }

    function test_claim_cannotExceedEscrow() public {
        // Escrow only 12k but operator (buggy) posts leaves summing to 15k.
        uint256 id = _createFundedCampaign(12_000e18);
        (bytes32 root, bytes32[] memory pA, bytes32[] memory pB) =
            _tree(alice, 10_000e18, bob, 5_000e18);
        vm.prank(operator);
        dist.setRoot(id, root);

        vm.prank(alice);
        dist.claim(id, alice, 10_000e18, pA);
        // Bob's 5k would push distributed to 15k > 12k escrow: hard revert.
        vm.prank(bob);
        vm.expectRevert(ArcadeIncentiveDistributor.ExceedsEscrow.selector);
        dist.claim(id, bob, 5_000e18, pB);
    }

    function test_setRoot_onlyOperator() public {
        uint256 id = _createFundedCampaign(100_000e18);
        vm.prank(alice);
        vm.expectRevert(ArcadeIncentiveDistributor.NotOperator.selector);
        dist.setRoot(id, bytes32(uint256(1)));
    }

    // --- reclaim -------------------------------------------------------

    function test_reclaim_afterGrace() public {
        uint256 id = _createFundedCampaign(100_000e18);
        (bytes32 root, bytes32[] memory pA,) = _tree(alice, 10_000e18, bob, 5_000e18);
        vm.prank(operator);
        dist.setRoot(id, root);
        vm.prank(alice);
        dist.claim(id, alice, 10_000e18, pA);

        // Too early.
        vm.prank(creator);
        vm.expectRevert(ArcadeIncentiveDistributor.TooEarlyToReclaim.selector);
        dist.reclaim(id);

        vm.warp(uint256(end) + 3 days + 1);
        vm.prank(creator);
        dist.reclaim(id);
        // 100k escrow - 10k claimed = 90k back to creator.
        assertEq(reward.balanceOf(creator), 1_000_000e18 - 100_000e18 + 90_000e18);

        // No double reclaim.
        vm.prank(creator);
        vm.expectRevert(ArcadeIncentiveDistributor.AlreadyReclaimed.selector);
        dist.reclaim(id);
    }

    function test_claim_blockedAfterReclaim_noCrossCampaignDrain() public {
        // Two campaigns funded with the SAME reward token, commingled balance.
        uint256 idA = _createFundedCampaign(100_000e18);
        uint256 idB = _createFundedCampaign(100_000e18);
        assertEq(reward.balanceOf(address(dist)), 200_000e18);

        // A's root: alice 10k (claims), bob 50k (a late claimer who waits).
        (bytes32 rootA, bytes32[] memory pAliceA, bytes32[] memory pBobA) =
            _tree(alice, 10_000e18, bob, 50_000e18);
        vm.prank(operator);
        dist.setRoot(idA, rootA);
        vm.prank(alice);
        dist.claim(idA, alice, 10_000e18, pAliceA);

        // Creator reclaims A after grace (remainder 90k back).
        vm.warp(uint256(end) + 3 days + 1);
        vm.prank(creator);
        dist.reclaim(idA);

        // Bob now tries his valid A proof AFTER reclaim: must be blocked, else
        // he'd pull 50k out of campaign B's escrow.
        vm.prank(bob);
        vm.expectRevert(ArcadeIncentiveDistributor.CampaignClosed.selector);
        dist.claim(idA, bob, 50_000e18, pBobA);

        // Campaign B's full escrow is intact.
        ArcadeIncentiveDistributor.Campaign memory cB = dist.campaigns(idB);
        assertEq(cB.total, 100_000e18);
        assertEq(cB.distributed, 0);
        // Contract holds exactly B's escrow (A: 100k in, 10k claimed, 90k reclaimed = 0 left).
        assertEq(reward.balanceOf(address(dist)), 100_000e18);
    }

    function test_reclaim_onlyCreator() public {
        uint256 id = _createFundedCampaign(100_000e18);
        vm.warp(uint256(end) + 3 days + 1);
        vm.prank(alice);
        vm.expectRevert(ArcadeIncentiveDistributor.NotCreator.selector);
        dist.reclaim(id);
    }

    // --- admin ---------------------------------------------------------

    function test_setOperator_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        dist.setOperator(alice);

        dist.setOperator(bob);
        assertEq(dist.operator(), bob);
    }
}
