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

    /// @notice If nonzero, only this address may perform the FIRST mint (and any
    ///         sync while totalSupply == 0). Set once by the factory at creation
    ///         for launchpad-owned pairs so the deterministic pair address cannot
    ///         be pre-minted / poisoned before the launchpad seeds it at
    ///         graduation. Normal pairs leave this zero and stay fully
    ///         permissionless. Once the first (gated) mint lands, the pair is
    ///         permissionless forever.
    address public seedGate;

    /// @notice When non-zero, this pair is a GRADUATED launchpad market and the
    ///         0.30% the trader already pays is split at the POOL level:
    ///         0.10% stays in reserves (LPs), 0.15% goes to the protocol
    ///         (`factory.feeTo`) and 0.05% to `launchCreator`.
    ///
    ///         Why this exists. Graduated pairs mint 100% of their LP to DEAD,
    ///         so "0.30% to LPs" means the FULL 0.30% accrues to an unclaimable
    ///         position. Note `feeTo`'s 1/6 does NOT land here: _mintFee only
    ///         runs from mint()/burn(), and a graduated pair sees neither once
    ///         the LP is burned. It is dormant rather than destroyed (mint() is
    ///         permissionless once seeded, so the protocol can poke the pair
    ///         with dust to crystallise the growth since kLast) but poking caps
    ///         at 1/6 of 0.30% = 5bps. That is exactly pump.fun's 5bps
    ///         post-graduation take, which is what V2-family economics pay a
    ///         protocol that never touches swap(). Skimming here gets 15bps, 3x
    ///         that, with no keeper poking pairs forever. The protocol's answer used to be
    ///         a 0.30% royalty bolted onto launchpad.buyMigrated/sellMigrated,
    ///         but the pair is a permissionless V2 pool, so anyone trading it
    ///         directly paid 0 and it cost them HALF (0.30% vs 0.60% via the
    ///         UI). A fee only honest users pay is worse than no fee.
    ///
    ///         Charging it here instead makes it unavoidable: it lives in the
    ///         K invariant of the contract that custodies the liquidity, so
    ///         every route (our router, any aggregator, a raw pair.swap, a
    ///         flash-swap callback) pays it. Trader cost DROPS 0.60% -> 0.30%
    ///         and is identical everywhere. Same economics as the old royalty
    ///         (0.15+0.05 here vs 0.20+0.10 there), but collected.
    ///
    ///         Zero on ordinary DEX pairs, which keep stock V2 behaviour
    ///         (full 0.30% to real LPs + the 1/6 `feeTo` mint), so genuine
    ///         liquidity providers are not taxed by this.
    address public launchCreator;

    /// @notice Optional second creator recipient and its share (in bps) of the
    ///         CREATOR leg only. Mirrors the launchpad's own creator/creator2
    ///         model, which _distributeMigratedFee used to honour. Without this
    ///         the pair would silently pay creator1 100% of the creator leg and
    ///         creator2 nothing, breaking a shipped CLANKER feature for launches
    ///         that already exist. Zero when the launch has a single creator.
    address public launchCreator2;
    uint16 public creator2ShareBps;


    /// Basis points of the INPUT skimmed out of the pool per swap on a
    /// graduated pair. 15 protocol + 5 creator = 20; the remaining 10 of the
    /// trader's 30 stays in reserves.
    uint256 private constant LAUNCH_PROTOCOL_BPS = 15;
    uint256 private constant LAUNCH_CREATOR_BPS = 5;

    event LaunchCreatorSet(address indexed creator);
    event LaunchFeePaid(address indexed token, uint256 protocolAmount, uint256 creatorAmount);
    /// A fee leg we could not deliver; booked to the pull ledger instead of
    /// reverting the swap. Alarms that a recipient has stopped being payable.
    event LaunchFeeDeferred(address indexed token, address indexed to, uint256 amount);
    event LaunchFeeClaimed(address indexed token, address indexed to, uint256 amount);

    /// @notice Launch fees this pair owes but could not deliver, keyed
    ///         [token][recipient]. Claim with claimLaunchFees.
    mapping(address => mapping(address => uint256)) public pendingLaunchFees;
    /// @notice Per-token sum of pendingLaunchFees. Load-bearing for skim(),
    ///         which pays out `balanceOf - reserve` -- precisely the shape a
    ///         deferred fee has. Without this, skim() would hand a creator's
    ///         unclaimed fees to whoever calls it first.
    mapping(address => uint256) public pendingLaunchFeeTotal;

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

    function initialize(address _token0, address _token1, address _seedGate) external {
        if (msg.sender != factory) revert Forbidden();
        token0 = _token0;
        token1 = _token1;
        seedGate = _seedGate;
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
        // Net out the deferred launch fees, exactly as skim() and sync() do.
        // Raw balanceOf INCLUDES fees this pair owes but could not deliver, and
        // booking those as reserves is not cosmetic: `balanceOf - reserve` would
        // collapse to 0 while pendingLaunchFeeTotal stayed positive, so skim()
        // would underflow-revert FOREVER, and the creator's later
        // claimLaunchFees would drop the balance BELOW the recorded reserve,
        // leaving the pair quoting against depth it does not hold. mint() is
        // permissionless once seeded, and this contract's own docs describe
        // dust-poking as expected, so one poke was enough to trigger it.
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this)) - pendingLaunchFeeTotal[token0];
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this)) - pendingLaunchFeeTotal[token1];
        uint256 amount0 = balance0 - _r0;
        uint256 amount1 = balance1 - _r1;

        bool feeOn = _mintFee(_r0, _r1);
        uint256 _totalSupply = totalSupply;
        // Seed gate: on a launchpad-owned pair, only the launchpad may perform
        // the first mint. Blocks an attacker from pre-minting LP (L-1 theft) or
        // seeding a poisoned reserve that would revert / mis-price the
        // launchpad's graduation seed (H-1 brick). No-op for normal pairs.
        if (_totalSupply == 0 && seedGate != address(0) && msg.sender != seedGate) {
            revert Forbidden();
        }
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
        // Net out the deferred launch fees. On raw balances an LP's pro-rata
        // slice INCLUDES money the pair owes the creator, so burning paid out a
        // share of it -- mint-then-burn in one block extracted it for the cost of
        // gas, and pendingLaunchFeeTotal still promised the creator an amount the
        // pair no longer held, so the residue came out of the remaining LPs.
        // Same netting as skim()/sync()/mint(): what is owed is not liquidity.
        uint256 balance0 = IERC20Minimal(_t0).balanceOf(address(this)) - pendingLaunchFeeTotal[_t0];
        uint256 balance1 = IERC20Minimal(_t1).balanceOf(address(this)) - pendingLaunchFeeTotal[_t1];
        uint256 liquidity = balanceOf[address(this)];

        bool feeOn = _mintFee(_r0, _r1);
        uint256 _totalSupply = totalSupply;
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);
        _safeTransfer(_t0, to, amount0);
        _safeTransfer(_t1, to, amount1);
        balance0 = IERC20Minimal(_t0).balanceOf(address(this)) - pendingLaunchFeeTotal[_t0];
        balance1 = IERC20Minimal(_t1).balanceOf(address(this)) - pendingLaunchFeeTotal[_t1];

        _update(balance0, balance1, _r0, _r1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 _r0, uint112 _r1,) = getReserves();
        if (amount0Out >= _r0 || amount1Out >= _r1) revert InsufficientLiquidity();

        address _creator = launchCreator;

        uint256 balance0;
        uint256 balance1;
        {
            address _t0 = token0;
            address _t1 = token1;
            if (to == _t0 || to == _t1) revert InvalidTo();

            // `to` receives EXACTLY amount0Out / amount1Out. Never skim the
            // output. The V2 promise "the recipient gets exactly what was
            // requested" is load-bearing for the entire periphery: the stock
            // router checks amountOutMin against the LIBRARY-COMPUTED figure
            // BEFORE swapping and never re-reads balances, so an under-
            // delivering pair defeats slippage protection SILENTLY (a
            // fund-loss bug, verified against v2-periphery). Multi-hop is
            // worse: the next pair is sent a short input against a full-size
            // requested output and reverts on K. PYESwap, the only EVM pair
            // that ever skimmed the output, had to ban multi-hop outright
            // (`require(path.length == 2)`) and lower users' slippage floors
            // to match its own lying quotes. We take the fee on the INPUT
            // instead (see below), which is what Camelot, Velodrome, Biswap,
            // ApeSwap and every other fork does.
            if (amount0Out > 0) _safeTransfer(_t0, to, amount0Out);
            if (amount1Out > 0) _safeTransfer(_t1, to, amount1Out);
            if (data.length > 0) IArcadeV2Callee(to).arcadeV2Call(msg.sender, amount0Out, amount1Out, data);
            // Net out the deferred launch fees, like EVERY other balance read in
            // this contract (mint, burn, skim, sync). Missing it here was the
            // worst instance of the four: `amount0In` is derived from this
            // balance, so on the swap AFTER a deferral the pair credits the
            // creator's OWED fee as fresh trader input. A passer-by could then
            // call swap() sending ZERO tokens and be paid out against it -- the
            // exact theft skim() was hardened against, walking back in through
            // the one function nothing gates. It also broke the
            // `pending <= balanceOf - reserve` invariant on an ordinary honest
            // sell, underflow-bricking skim()/mint() and letting claimLaunchFees
            // drop the balance below the recorded reserve.
            //
            // The read is taken BEFORE the fee block below, so the totals it
            // subtracts are the ones outstanding on entry; this swap's own
            // deferrals are added afterwards and correctly excluded here.
            balance0 = IERC20Minimal(_t0).balanceOf(address(this)) - pendingLaunchFeeTotal[_t0];
            balance1 = IERC20Minimal(_t1).balanceOf(address(this)) - pendingLaunchFeeTotal[_t1];
        }

        uint256 amount0In = balance0 > _r0 - amount0Out ? balance0 - (_r0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _r1 - amount1Out ? balance1 - (_r1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();

        // Skim 20bps of the INPUT out to protocol + creator (whichever token
        // came in), leaving 10bps of the trader's 30 in reserves. This is
        // Camelot's / Velodrome's pattern: measure the input, move the fee out
        // of the pool, re-read balances, then check K on what is left.
        //
        // Fuzzed over 230k reserve/input combinations: there is NO case where
        // this pair can deliver less than a stock 997/1000 quote, because
        //     (B - 2*in/1000)*1000 - in*1  ==  B*1000 - 3*in
        // is exactly stock V2's `balance*1000 - amountIn*3`. The only deviation
        // is a floor() artifact of at most ~1 wei of input, always in the
        // trader's favour. So `UniswapV2Library` stays bit-exact, the stock
        // router's amountOutMin still protects users, and 0x / 1inch /
        // KyberSwap quote us correctly with ZERO special-casing.
        //
        // This holds ONLY because the TOTAL stays pinned at 0.30%. Camelot and
        // Biswap both broke stock-library pricing by making the total variable,
        // forcing every quoter to read a per-pair fee. Never make the total
        // configurable per pair.
        //
        // Consequence to own honestly: on a sell the fee accrues in the LAUNCH
        // token, not USDC. That is unavoidable input-side, and it is what
        // Camelot does (accumulate raw, convert off-chain). Sweeping it is an
        // ops detail, invisible to integrators -- unlike an output skim, which
        // is a fund-loss bug.
        // `feePaid` is what ACTUALLY left. The K check is derived from it, not
        // from a hardcoded coefficient -- that was the root cause of audit
        // F-3/F-4: the coefficient is not a constant, it is a function of the
        // fee that actually departed. The old code forced coeff = 1 whenever a
        // launch fee existed, but zeroed the protocol leg when feeTo was unset,
        // so the pair silently became a 15bps pool that still quoted 30bps --
        // and anyone calling swap() directly pocketed the difference. It failed
        // toward the TRADER, not the pool, contrary to the comment that stood
        // here. Same root cause made dust inputs (whose legs floor to 0) a
        // 10bps pool.
        uint256 fee0Paid;
        uint256 fee1Paid;
        if (_creator != address(0)) {
            if (amount0In > 0) {
                (uint256 p, uint256 c) = _payLaunchFee(token0, amount0In, _creator);
                fee0Paid = p + c;
                balance0 -= fee0Paid;
            }
            if (amount1In > 0) {
                (uint256 p, uint256 c) = _payLaunchFee(token1, amount1In, _creator);
                fee1Paid = p + c;
                balance1 -= fee1Paid;
            }
        }
        {
            // Rebased to 10000. Because balance_post + feePaid == balance_pre:
            //   balance*10000 - in*30 + feePaid*10000 == balance_pre*10000 - in*30
            // which is EXACTLY stock V2's `balance*1000 - in*3`, scaled by 10.
            // Holds for ANY feePaid including 0 (ordinary pair, unset feeTo, or
            // a dust input whose legs floor away) with no rounding cases:
            // whatever is not removed simply stays in the pool, which IS the
            // stock outcome. One expression, no branch, no coefficient to keep
            // in sync with the fee.
            uint256 balance0Adj = (balance0 * 10_000) - (amount0In * 30) + (fee0Paid * 10_000);
            uint256 balance1Adj = (balance1 * 10_000) - (amount1In * 30) + (fee1Paid * 10_000);
            if (balance0Adj * balance1Adj < uint256(_r0) * uint256(_r1) * 100_000_000) {
                revert KInvariant();
            }
        }
        _update(balance0, balance1, _r0, _r1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @notice Mark this pair as a graduated launchpad market. Only the
    ///         seedGate (the launchpad) can call it, and only once, so a pair's
    ///         fee split can never be changed under its LPs after the fact.
    ///         Ordinary pairs never get this and keep stock V2 behaviour.
    function setLaunchCreator(address creator, address creator2, uint16 creator2Bps) external {
        address _gate = seedGate;
        if (_gate == address(0) || msg.sender != _gate) revert Forbidden();
        if (launchCreator != address(0)) revert Forbidden(); // set once
        if (creator == address(0)) revert Forbidden();
        // NORMALISE, never revert. This runs inside _migrate, i.e. inside the
        // buy that completes the curve: a revert here freezes the launch one
        // buy short of graduation, forever, with real money in it. Anything on
        // that path must be TOTAL. createToken accepts {creator2 != 0, bps = 0}
        // (only bps > 10_000 reverts), so rejecting it here bricked a config
        // the system had always accepted. (Audit F-1.)
        if (creator2Bps > 10_000) revert Forbidden();
        if (creator2Bps == 0) creator2 = address(0);
        if (creator2 == address(0)) creator2Bps = 0;
        launchCreator = creator;
        launchCreator2 = creator2;
        creator2ShareBps = creator2Bps;
        emit LaunchCreatorSet(creator);
    }

    /// @dev Pay the protocol + creator legs of a graduated pair's swap fee.
    ///      Rounds DOWN, and a zero-address feeTo simply routes nothing (the
    ///      pool keeps it, i.e. stock behaviour), so an unset factory feeTo can
    ///      never brick swaps.
    ///
    ///      Every leg goes through _payOrCreditFee, NEVER a hard _safeTransfer.
    ///      These transfers run inside swap(), and `launchCreator` is set-once
    ///      with no setter (setLaunchCreator is seedGate-only and one-shot), so
    ///      a hard transfer meant that Circle blacklisting the creator would
    ///      revert EVERY USDC-in swap on that pair forever: the market goes
    ///      sell-only and dies, unrecoverably, taking the creator's own future
    ///      fees with it. This is the same hard-transfer-to-an-immutable-
    ///      recipient pattern already fixed in ArcadeLaunchpad._safePayUsdc,
    ///      ArcadeV3Locker._payOrCredit, ArcadeCctpBuyReceiver.pendingFees and
    ///      ArcadeV3SwapRouter.pendingSnipeFees -- the sixth instance. The payer
    ///      always pays; only the destination may defer.
    function _payLaunchFee(address token, uint256 amount, address creator)
        private
        returns (uint256 protocolAmount, uint256 creatorAmount)
    {
        address feeTo = IArcadeV2Factory(factory).feeTo();
        protocolAmount = feeTo == address(0) ? 0 : (amount * LAUNCH_PROTOCOL_BPS) / 10_000;
        creatorAmount = (amount * LAUNCH_CREATOR_BPS) / 10_000;
        if (protocolAmount > 0) _payOrCreditFee(token, feeTo, protocolAmount);
        if (creatorAmount > 0) {
            address _c2 = launchCreator2;
            uint256 c2Amount = _c2 == address(0)
                ? 0
                : (creatorAmount * creator2ShareBps) / 10_000;
            // creator1 takes the remainder, so rounding dust never strands and
            // the two legs always sum to exactly creatorAmount.
            if (c2Amount > 0) _payOrCreditFee(token, _c2, c2Amount);
            uint256 c1Amount = creatorAmount - c2Amount;
            if (c1Amount > 0) _payOrCreditFee(token, creator, c1Amount);
        }
        if (protocolAmount > 0 || creatorAmount > 0) {
            emit LaunchFeePaid(token, protocolAmount, creatorAmount);
        }
    }

    /// @dev Try to hand `amount` to `to`; on ANY failure, book it to the pull
    ///      ledger instead of reverting the swap.
    ///
    ///      The amount is deducted from `balance` by the caller either way, so
    ///      it leaves the reserves either way -- the K check and the price are
    ///      identical whether the leg was delivered or deferred. What changes is
    ///      only WHERE the tokens sit.
    function _payOrCreditFee(address token, address to, uint256 amount) private {
        uint256 heldBefore = IERC20Minimal(token).balanceOf(address(this));
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))))) return;
        // The call did not cleanly report success -- but it may still have MOVED
        // the tokens. This gate is `data.length >= 32`, while _safeTransfer's is
        // `data.length != 0`, so the two disagree on a 1-31 byte return: that is
        // a transfer which may well have succeeded and reports nothing usable.
        //
        // Booking a pending for money that already left is the WORSE failure of
        // the two. It pushes pendingLaunchFeeTotal above `balanceOf - reserve`,
        // and skim/sync/mint/burn ALL subtract it -- so a phantom credit
        // underflow-bricks all four, permanently and silently, on an otherwise
        // healthy pair. Reverting here would at least be loud.
        //
        // So do not infer from the return value: measure. Defer only what we can
        // prove we still hold. One extra balanceOf, on the rare failure path
        // only, against an already-warm token.
        if (IERC20Minimal(token).balanceOf(address(this)) < heldBefore) return; // it left anyway
        pendingLaunchFees[token][to] += amount;
        // Tracked in aggregate too, because skim() pays out
        // `balanceOf - reserve` and a deferred fee is EXACTLY that difference:
        // without netting it out, the first caller of skim() would walk off with
        // the creator's unclaimed fees. (The CCTP receiver shipped this same
        // bug: its leftover sweep ate the deferred fee.)
        pendingLaunchFeeTotal[token] += amount;
        emit LaunchFeeDeferred(token, to, amount);
    }

    /// @notice Withdraw launch fees this pair could not deliver (eg the
    ///         recipient was blacklisted at the time of the swap). Permissionless
    ///         and always pays msg.sender, so nobody can redirect it.
    function claimLaunchFees(address token) external lock returns (uint256 amount) {
        amount = pendingLaunchFees[token][msg.sender];
        if (amount == 0) revert Forbidden();
        // Zeroed BEFORE the transfer: a revert rolls both back and preserves the
        // row for a retry; a reentrant token reads 0.
        pendingLaunchFees[token][msg.sender] = 0;
        pendingLaunchFeeTotal[token] -= amount;
        _safeTransfer(token, msg.sender, amount);
        emit LaunchFeeClaimed(token, msg.sender, amount);
    }

    /// @dev Nets out pendingLaunchFeeTotal. skim() exists to sweep the gap
    ///      between the real balance and the booked reserves to an ARBITRARY
    ///      caller, and a deferred launch fee is exactly that gap -- it sits in
    ///      this contract while _update has already excluded it from reserves.
    ///      Un-netted, the first person to call skim() on a pair with a
    ///      blacklisted creator would take the creator's fees. Only genuine
    ///      donations are skimmable.
    function skim(address to) external lock {
        address _t0 = token0;
        address _t1 = token1;
        _safeTransfer(
            _t0,
            to,
            IERC20Minimal(_t0).balanceOf(address(this)) - reserve0 - pendingLaunchFeeTotal[_t0]
        );
        _safeTransfer(
            _t1,
            to,
            IERC20Minimal(_t1).balanceOf(address(this)) - reserve1 - pendingLaunchFeeTotal[_t1]
        );
    }

    function sync() external lock {
        // While the pair is unseeded, gate sync too: otherwise an attacker could
        // donate tokens and sync them into reserves, defeating the pre-seed skim
        // and forcing the launchpad's first mint to open at a poisoned price.
        if (totalSupply == 0 && seedGate != address(0) && msg.sender != seedGate) {
            revert Forbidden();
        }
        // Net out the deferred launch fees for the same reason skim() does:
        // they are physically held here but are OWED, not liquidity. Syncing
        // them into reserves would book someone else's fee as pool depth, and
        // the later claimLaunchFees would then drop the balance BELOW the
        // recorded reserve -- underflowing skim() and leaving the pair quoting
        // against depth it does not have.
        _update(
            IERC20Minimal(token0).balanceOf(address(this)) - pendingLaunchFeeTotal[token0],
            IERC20Minimal(token1).balanceOf(address(this)) - pendingLaunchFeeTotal[token1],
            reserve0,
            reserve1
        );
    }
}
