// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArcadeV2Pair} from "./ArcadeV2Pair.sol";
import {IArcadeV2Factory} from "./interfaces/IArcadeV2Factory.sol";

contract ArcadeV2Factory is IArcadeV2Factory {
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public override getPair;
    address[] public override allPairs;

    error IdenticalAddresses();
    error ZeroAddress();
    error PairExists();
    error Forbidden();

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view override returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external override returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        ArcadeV2Pair newPair = new ArcadeV2Pair{salt: salt}();
        newPair.initialize(token0, token1);
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

    /// @notice Init code hash needed by off-chain pair address derivation.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(ArcadeV2Pair).creationCode);
    }
}
