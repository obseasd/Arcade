// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArcadeV2ERC20} from "./ArcadeV2ERC20.sol";
import {IArcadeV2Factory} from "./interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Pair} from "./interfaces/IArcadeV2Pair.sol";
import {Math} from "./libraries/Math.sol";
import {UQ112x112} from "./libraries/UQ112x112.sol";

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IArcadeV2Callee {
    function arcadeV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

contract ArcadeV2Pair is ArcadeV2ERC20 {
    using UQ112x112 for uint224;

    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 3;

    address public factory;
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 public kLast;

    uint256 private unlocked = 1;

    error Locked();
    error Forbidden();
    error Overflow();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error InsufficientInputAmount();
    error KInvariant();
    error TransferFailed();

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor() {
        factory = msg.sender;
    }

    function initialize(address _token0, address _token1) external {
        if (msg.sender != factory) revert Forbidden();
        token0 = _token0;
        token1 = _token1;
    }

    function getReserves() public view returns (uint112 _r0, uint112 _r1, uint32 _ts) {
        _r0 = reserve0;
        _r1 = reserve1;
        _ts = blockTimestampLast;
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        uint32 ts = uint32(block.timestamp % 2 ** 32);
        unchecked {
            uint32 elapsed = ts - blockTimestampLast;
            if (elapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                price0CumulativeLast += uint256(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * elapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * elapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = ts;
        emit Sync(reserve0, reserve1);
    }

    function _mintFee(uint112 _r0, uint112 _r1) private returns (bool feeOn) {
        address feeTo = IArcadeV2Factory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = Math.sqrt(uint256(_r0) * uint256(_r1));
                uint256 rootKLast = Math.sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply * (rootK - rootKLast);
                    uint256 denominator = (rootK * 5) + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _r0, uint112 _r1,) = getReserves();
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _r0;
        uint256 amount1 = balance1 - _r1;

        bool feeOn = _mintFee(_r0, _r1);
        uint256 _totalSupply = totalSupply;
        if (_totalSupply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY); // permanent lock (avoid address(0) on 0.8.x)
        } else {
            liquidity = Math.min((amount0 * _totalSupply) / _r0, (amount1 * _totalSupply) / _r1);
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(balance0, balance1, _r0, _r1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);
        emit Mint(msg.sender, amount0, amount1);
    }

    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _r0, uint112 _r1,) = getReserves();
        address _t0 = token0;
        address _t1 = token1;
        uint256 balance0 = IERC20Minimal(_t0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(_t1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];

        bool feeOn = _mintFee(_r0, _r1);
        uint256 _totalSupply = totalSupply;
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);
        _safeTransfer(_t0, to, amount0);
        _safeTransfer(_t1, to, amount1);
        balance0 = IERC20Minimal(_t0).balanceOf(address(this));
        balance1 = IERC20Minimal(_t1).balanceOf(address(this));

        _update(balance0, balance1, _r0, _r1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 _r0, uint112 _r1,) = getReserves();
        if (amount0Out >= _r0 || amount1Out >= _r1) revert InsufficientLiquidity();

        uint256 balance0;
        uint256 balance1;
        {
            address _t0 = token0;
            address _t1 = token1;
            if (to == _t0 || to == _t1) revert InvalidTo();
            if (amount0Out > 0) _safeTransfer(_t0, to, amount0Out);
            if (amount1Out > 0) _safeTransfer(_t1, to, amount1Out);
            if (data.length > 0) IArcadeV2Callee(to).arcadeV2Call(msg.sender, amount0Out, amount1Out, data);
            balance0 = IERC20Minimal(_t0).balanceOf(address(this));
            balance1 = IERC20Minimal(_t1).balanceOf(address(this));
        }

        uint256 amount0In = balance0 > _r0 - amount0Out ? balance0 - (_r0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _r1 - amount1Out ? balance1 - (_r1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();
        {
            uint256 balance0Adj = (balance0 * 1000) - (amount0In * 3);
            uint256 balance1Adj = (balance1 * 1000) - (amount1In * 3);
            if (balance0Adj * balance1Adj < uint256(_r0) * uint256(_r1) * 1_000_000) revert KInvariant();
        }
        _update(balance0, balance1, _r0, _r1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    function skim(address to) external lock {
        address _t0 = token0;
        address _t1 = token1;
        _safeTransfer(_t0, to, IERC20Minimal(_t0).balanceOf(address(this)) - reserve0);
        _safeTransfer(_t1, to, IERC20Minimal(_t1).balanceOf(address(this)) - reserve1);
    }

    function sync() external lock {
        _update(
            IERC20Minimal(token0).balanceOf(address(this)),
            IERC20Minimal(token1).balanceOf(address(this)),
            reserve0,
            reserve1
        );
    }
}
