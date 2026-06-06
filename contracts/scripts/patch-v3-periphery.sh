#!/usr/bin/env bash
# patch-v3-periphery.sh
#
# Patches the canonical Uniswap V3 POOL_INIT_CODE_HASH in the vendored
# v3-periphery submodule to match the bytecode hash our Forge profile
# actually produces for UniswapV3Pool.
#
# WHY: PoolAddress.computeAddress derives the pool address via CREATE2
#      using the init code hash of the pool's creationCode. Uniswap's
#      canonical value (0xe34f199b...) is the keccak of the hardhat-built
#      bytecode. Forge's solc settings produce a DIFFERENT bytecode (the
#      metadata hash baked into the contract differs even when source +
#      optimizer match), so the computed address is wrong and every NPM
#      mint reverts with "call to non-contract address". This is a known
#      pitfall for anyone forking V3 periphery with Foundry; see Uniswap
#      issue #1100 and the v3-deploy README.
#
# WHEN: Run once per fresh clone, before `FOUNDRY_PROFILE=v3 forge build`
#       or any forge script that compiles ArcadeV3PositionManager. The
#       deploy script for the NPM mentions it in its header comment.
#
# IDEMPOTENT: re-running is safe — the sed targets the canonical value
#             and is a no-op once already patched.

set -euo pipefail

FILE="lib/v3-periphery/contracts/libraries/PoolAddress.sol"
OLD_HASH="0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54"
NEW_HASH="0xca68598c9e9702a745bd8d56921f993b83d11dc12e6e453d03aebbbe520413a1"

if [ ! -f "$FILE" ]; then
    echo "ERROR: $FILE not found — run from contracts/ root." >&2
    exit 1
fi

if grep -q "$NEW_HASH" "$FILE"; then
    echo "Already patched."
    exit 0
fi

if ! grep -q "$OLD_HASH" "$FILE"; then
    echo "ERROR: neither old nor new hash found in $FILE; submodule state unexpected." >&2
    exit 1
fi

# Portable sed (BSD on macOS, GNU on Linux/Git Bash).
sed -i.bak "s/$OLD_HASH/$NEW_HASH/" "$FILE"
rm -f "$FILE.bak"

echo "Patched $FILE: POOL_INIT_CODE_HASH -> $NEW_HASH"
echo "Now run: FOUNDRY_PROFILE=v3 forge build --use 0.7.6"
