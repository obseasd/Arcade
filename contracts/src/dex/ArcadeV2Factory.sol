// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArcadeV2Pair} from "./ArcadeV2Pair.sol";
import {IArcadeV2Factory} from "./interfaces/IArcadeV2Factory.sol";

contract ArcadeV2Factory is IArcadeV2Factory {
    address public feeTo;
    address public feeToSetter;
    /// @notice The launchpad allowed to create seed-gated pairs. Set once by the
    ///         feeToSetter after the launchpad is deployed.
    address public override launchpad;

    mapping(address => mapping(address => address)) public override getPair;
    address[] public override allPairs;

    error IdenticalAddresses();
    error ZeroAddress();
    error PairExists();
    error Forbidden();
    error NoCode();

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view override returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external override returns (address pair) {
        // Both tokens must already be deployed. A launchpad token's pair address
        // is deterministic (CREATE from the launchpad), so without this guard an
        // attacker could pre-occupy that slot via this permissionless path BEFORE
        // the token exists, making the launchpad's later createPairGated revert
        // (PairExists) and bricking every PUMP/CLANKER launch. At front-run time
        // the predicted token has no code; the launchpad only calls
        // createPairGated AFTER `new ArcadeLaunchToken` deploys code, and every
        // legitimate USDC pool pairs already-deployed tokens, so this is safe.
        if (tokenA.code.length == 0 || tokenB.code.length == 0) revert NoCode();
        return _createPair(tokenA, tokenB, address(0));
    }

    /// @notice Launchpad-only. Same as createPair but stamps the launchpad as the
    ///         pair's seedGate so only it can perform the first mint (blocks
    ///         pre-mint poisoning of the deterministic pair before graduation).
    function createPairGated(address tokenA, address tokenB) external override returns (address pair) {
        if (msg.sender != launchpad) revert Forbidden();
        return _createPair(tokenA, tokenB, msg.sender);
    }

    function _createPair(address tokenA, address tokenB, address seedGate_) private returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        ArcadeV2Pair newPair = new ArcadeV2Pair{salt: salt}();
        newPair.initialize(token0, token1, seedGate_);
        pair = address(newPair);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external override {
        if (msg.sender != feeToSetter) revert Forbidden();
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external override {
        if (msg.sender != feeToSetter) revert Forbidden();
        feeToSetter = _feeToSetter;
    }

    function setLaunchpad(address _launchpad) external override {
        if (msg.sender != feeToSetter) revert Forbidden();
        launchpad = _launchpad;
    }

    /// @notice Init code hash needed by off-chain pair address derivation.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(ArcadeV2Pair).creationCode);
    }
}
