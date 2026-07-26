// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {FeeProtocolManager, IV3LockerMin} from "src/FeeProtocolManager.sol";

contract MockFactory {
    address public owner;
    uint24 public lastFee;
    int24 public lastSpacing;

    constructor(address _owner) {
        owner = _owner;
    }

    function setOwner(address o) external {
        owner = o;
    }

    function enableFeeAmount(uint24 fee, int24 spacing) external {
        lastFee = fee;
        lastSpacing = spacing;
    }
}

contract MockPool {
    uint24 public fee;
    address public token0;
    address public token1;
    uint8 public feeProtocolPacked; // fp0 + (fp1 << 4)

    // collectProtocol capture
    address public lastCollectRecipient;
    uint128 public collectReturn0 = 111;
    uint128 public collectReturn1 = 222;

    constructor(uint24 _fee, address _t0, address _t1) {
        fee = _fee;
        token0 = _t0;
        token1 = _t1;
    }

    function setFeeProtocol(uint8 fp0, uint8 fp1) external {
        // Mirror v3-core's bound so setFeeProtocolRaw with a bad value reverts here
        // exactly as the real pool would.
        require(
            (fp0 == 0 || (fp0 >= 4 && fp0 <= 10)) && (fp1 == 0 || (fp1 >= 4 && fp1 <= 10)),
            "invalid fp"
        );
        feeProtocolPacked = fp0 + (fp1 << 4);
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, 0, 0, 0, 0, feeProtocolPacked, true);
    }

    function collectProtocol(address recipient, uint128, uint128) external returns (uint128, uint128) {
        lastCollectRecipient = recipient;
        return (collectReturn0, collectReturn1);
    }

    function fp0() external view returns (uint8) {
        return feeProtocolPacked % 16;
    }

    function fp1() external view returns (uint8) {
        return feeProtocolPacked >> 4;
    }
}

contract MockLocker {
    mapping(address => uint256) public positionIdByToken;
    mapping(uint256 => IV3LockerMin.Position) internal positions;
    uint256 public count;

    // Register `token` as locked to `pool`.
    function lock(address token, address pool) external returns (uint256 id) {
        id = ++count;
        positionIdByToken[token] = id;
        IV3LockerMin.Position storage p = positions[id];
        p.pool = pool;
        p.exists = true;
    }

    function getPosition(uint256 id) external view returns (IV3LockerMin.Position memory) {
        return positions[id];
    }
}

contract FeeProtocolManagerTest is Test {
    FeeProtocolManager mgr;
    MockFactory factory;
    MockLocker locker;

    address safe = makeAddr("safe");
    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");

    address USDC = address(0x3600);
    address TOKEN = address(0xBEEF);

    function setUp() public {
        factory = new MockFactory(address(this));
        locker = new MockLocker();
        mgr = new FeeProtocolManager(address(factory), address(locker), safe, treasury);
        // Simulate the deploy handover: factory owner -> the manager.
        factory.setOwner(address(mgr));
    }

    function _pool(uint24 fee) internal returns (MockPool) {
        return new MockPool(fee, USDC, TOKEN);
    }

    // -------- constructor / tier map --------

    function test_constructor_tierDefaults() public {
        assertEq(mgr.tierDefault(100), 4);
        assertEq(mgr.tierDefault(500), 4);
        assertEq(mgr.tierDefault(3000), 6);
        assertEq(mgr.tierDefault(10000), 6);
        assertTrue(mgr.tierKnown(500));
        assertFalse(mgr.tierKnown(20000)); // launch-only tier not managed
        assertEq(mgr.owner(), safe);
        assertEq(mgr.treasury(), treasury);
    }

    // -------- sync on ordinary pools --------

    function test_sync_ordinary_lowTier_sets4() public {
        MockPool p = _pool(500);
        mgr.sync(address(p));
        assertEq(p.fp0(), 4);
        assertEq(p.fp1(), 4);
    }

    function test_sync_ordinary_highTier_sets6() public {
        MockPool p = _pool(3000);
        mgr.sync(address(p));
        assertEq(p.fp0(), 6);
        assertEq(p.fp1(), 6);
    }

    function test_sync_isIdempotent() public {
        MockPool p = _pool(500);
        mgr.sync(address(p));
        mgr.sync(address(p));
        assertEq(p.fp0(), 4);
    }

    function test_sync_permissionless() public {
        MockPool p = _pool(500);
        vm.prank(attacker);
        mgr.sync(address(p)); // anyone may call
        assertEq(p.fp0(), 4);
    }

    function test_sync_unknownTier_reverts() public {
        MockPool p = _pool(20000); // launch-only tier
        vm.expectRevert(FeeProtocolManager.UnknownTier.selector);
        mgr.sync(address(p));
    }

    function test_sync_whenPaused_reverts() public {
        MockPool p = _pool(500);
        vm.prank(safe);
        mgr.setPaused(true);
        vm.expectRevert(FeeProtocolManager.Paused_.selector);
        mgr.sync(address(p));
    }

    // -------- launch pool exclusion --------

    function test_sync_launchPool_holdsZero() public {
        MockPool p = _pool(500);
        locker.lock(TOKEN, address(p)); // this pool is a launch pool
        mgr.sync(address(p));
        assertEq(p.fp0(), 0);
        assertEq(p.fp1(), 0);
    }

    function test_frontRun_then_lock_then_sync_healsToZero() public {
        // 1) attacker pre-creates + syncs the pool BEFORE it is locked -> enabled.
        MockPool p = _pool(500);
        vm.prank(attacker);
        mgr.sync(address(p));
        assertEq(p.fp0(), 4); // fee is on

        // 2) launchpad locks that exact pool.
        locker.lock(TOKEN, address(p));

        // 3) a later sync (keeper / launchpad forceZero) now reads it as launch
        //    and forces it back to 0. No permanent double-skim.
        mgr.sync(address(p));
        assertEq(p.fp0(), 0);
        assertEq(p.fp1(), 0);
    }

    function test_distinguisher_isPoolKeyed_notTokenKeyed() public {
        // The launch token T is locked to pool A. A SEPARATE ordinary pool B on
        // the same token at another tier must still be treated as ordinary.
        MockPool a = _pool(3000);
        locker.lock(TOKEN, address(a));
        MockPool b = new MockPool(500, USDC, TOKEN); // different pool, same token
        mgr.sync(address(b));
        assertEq(b.fp0(), 4); // ordinary -> skimmed (no fee-dodge)
        assertTrue(mgr.isLaunchPool(address(a)));
        assertFalse(mgr.isLaunchPool(address(b)));
    }

    // -------- forceZero --------

    function test_forceZero_onLaunchPool() public {
        MockPool p = _pool(500);
        mgr.sync(address(p)); // enabled first
        assertEq(p.fp0(), 4);
        locker.lock(TOKEN, address(p));
        mgr.forceZero(address(p)); // launchpad path
        assertEq(p.fp0(), 0);
    }

    function test_forceZero_onOrdinaryPool_reverts() public {
        MockPool p = _pool(500);
        // not locked -> forceZero must refuse, so it can never disable an
        // ordinary pool's fee.
        vm.expectRevert(FeeProtocolManager.NotLaunchPool.selector);
        mgr.forceZero(address(p));
    }

    // -------- harvest --------

    function test_collectProtocol_sendsToFixedTreasury() public {
        MockPool p = _pool(500);
        vm.prank(attacker); // permissionless trigger
        mgr.collectProtocol(address(p));
        assertEq(p.lastCollectRecipient(), treasury); // never the caller
    }

    // -------- governance / access control --------

    function test_setTierDefault_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FeeProtocolManager.NotOwner.selector);
        mgr.setTierDefault(500, 6);

        vm.prank(safe);
        mgr.setTierDefault(500, 6);
        assertEq(mgr.tierDefault(500), 6);
    }

    function test_setTierDefault_badValue_reverts() public {
        vm.prank(safe);
        vm.expectRevert(FeeProtocolManager.BadValue.selector);
        mgr.setTierDefault(500, 3); // v3-core allows only 0 or 4..10
    }

    function test_setTierDefault_zero_unmanages() public {
        vm.prank(safe);
        mgr.setTierDefault(500, 0);
        assertFalse(mgr.tierKnown(500));
        MockPool p = _pool(500);
        vm.expectRevert(FeeProtocolManager.UnknownTier.selector);
        mgr.sync(address(p));
    }

    function test_setFeeProtocolRaw_onlyOwner() public {
        MockPool p = _pool(500);
        vm.prank(attacker);
        vm.expectRevert(FeeProtocolManager.NotOwner.selector);
        mgr.setFeeProtocolRaw(address(p), 10, 10);

        vm.prank(safe);
        mgr.setFeeProtocolRaw(address(p), 10, 10);
        assertEq(p.fp0(), 10);
    }

    function test_transferFactoryOwnership_escapeHatch() public {
        vm.prank(safe);
        mgr.transferFactoryOwnership(safe);
        assertEq(factory.owner(), safe); // reclaimed to the Safe
    }

    function test_transferFactoryOwnership_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FeeProtocolManager.NotOwner.selector);
        mgr.transferFactoryOwnership(attacker);
    }

    function test_factoryEnableFeeAmount_proxied_onlyOwner_andSetsTier() public {
        vm.prank(attacker);
        vm.expectRevert(FeeProtocolManager.NotOwner.selector);
        mgr.factoryEnableFeeAmount(2500, 50, 6);

        // A new PUBLIC tier: enabling it ALSO sets its default in one call, so an
        // ordinary pool on it is skimmable immediately (no forgotten-default dodge).
        vm.prank(safe);
        mgr.factoryEnableFeeAmount(2500, 50, 6);
        assertEq(factory.lastFee(), 2500);
        assertEq(factory.lastSpacing(), int24(50));
        assertEq(mgr.tierDefault(2500), 6);
        assertTrue(mgr.tierKnown(2500));

        // A launch-only tier: default 0 keeps it unmanaged (sync reverts).
        vm.prank(safe);
        mgr.factoryEnableFeeAmount(30000, 200, 0);
        assertFalse(mgr.tierKnown(30000));
    }

    function test_setFeeProtocolRaw_invalidValue_reverts() public {
        MockPool p = _pool(500);
        vm.prank(safe);
        vm.expectRevert(bytes("invalid fp")); // pool enforces v3-core's {0} u [4,10]
        mgr.setFeeProtocolRaw(address(p), 3, 3);
    }

    function test_setTreasury_setPaused_onlyOwner() public {
        vm.startPrank(attacker);
        vm.expectRevert(FeeProtocolManager.NotOwner.selector);
        mgr.setTreasury(attacker);
        vm.expectRevert(FeeProtocolManager.NotOwner.selector);
        mgr.setPaused(true);
        vm.expectRevert(FeeProtocolManager.NotOwner.selector);
        mgr.transferOwnership(attacker);
        vm.stopPrank();

        vm.prank(safe);
        mgr.setTreasury(attacker);
        assertEq(mgr.treasury(), attacker);
    }

    function test_transferOwnership_isTwoStep() public {
        vm.prank(safe);
        mgr.transferOwnership(attacker);
        assertEq(mgr.owner(), safe); // not yet
        assertEq(mgr.pendingOwner(), attacker);

        // wrong acceptor rejected
        vm.prank(makeAddr("rando"));
        vm.expectRevert(FeeProtocolManager.NotPendingOwner.selector);
        mgr.acceptOwnership();

        vm.prank(attacker);
        mgr.acceptOwnership();
        assertEq(mgr.owner(), attacker);
        assertEq(mgr.pendingOwner(), address(0));
    }

    function test_syncMany() public {
        MockPool a = _pool(500);
        MockPool b = _pool(3000);
        address[] memory pools = new address[](2);
        pools[0] = address(a);
        pools[1] = address(b);
        mgr.syncMany(pools);
        assertEq(a.fp0(), 4);
        assertEq(b.fp0(), 6);
    }

    function test_forceZero_notGatedByPaused() public {
        // A paused manager must NOT brick launches: forceZero (0 direction) works.
        MockPool p = _pool(500);
        mgr.sync(address(p));
        locker.lock(TOKEN, address(p));
        vm.prank(safe);
        mgr.setPaused(true);
        mgr.forceZero(address(p)); // still works while paused
        assertEq(p.fp0(), 0);
    }

    function test_constructor_zeroAddress_reverts_allParams() public {
        vm.expectRevert(FeeProtocolManager.ZeroAddress.selector);
        new FeeProtocolManager(address(0), address(locker), safe, treasury);
        vm.expectRevert(FeeProtocolManager.ZeroAddress.selector);
        new FeeProtocolManager(address(factory), address(0), safe, treasury);
        vm.expectRevert(FeeProtocolManager.ZeroAddress.selector);
        new FeeProtocolManager(address(factory), address(locker), address(0), treasury);
        vm.expectRevert(FeeProtocolManager.ZeroAddress.selector);
        new FeeProtocolManager(address(factory), address(locker), safe, address(0));
    }
}
