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
# The canonical Uniswap V3 hardhat build's POOL_INIT_CODE_HASH:
UNISWAP_HASH="0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54"
# Pre-gen-6 Forge build (bytecode_hash=ipfs default):
LEGACY_HASH="0xca68598c9e9702a745bd8d56921f993b83d11dc12e6e453d03aebbbe520413a1"
# Current Forge build hash, after foundry.toml 5ac0d6d (bytecode_hash=none + cbor_metadata=false):
NEW_HASH="0xd3e7f58b9af034cfa7a0597e539bae7c6b393817a47a6fc1e1503cd6eaffe22a"

if [ ! -f "$FILE" ]; then
    echo "ERROR: $FILE not found — run from contracts/ root." >&2
    exit 1
fi

if grep -q "$NEW_HASH" "$FILE"; then
    echo "Already patched."
    exit 0
fi

# Patch from either the canonical Uniswap hash (fresh forge install) OR
# the legacy gen-5 Arcade hash (pre-foundry.toml-strip rebuild).
if grep -q "$UNISWAP_HASH" "$FILE"; then
    FROM="$UNISWAP_HASH"
elif grep -q "$LEGACY_HASH" "$FILE"; then
    FROM="$LEGACY_HASH"
else
    echo "ERROR: no known hash found in $FILE; submodule state unexpected." >&2
    exit 1
fi

# Portable sed (BSD on macOS, GNU on Linux/Git Bash).
sed -i.bak "s/$FROM/$NEW_HASH/" "$FILE"
rm -f "$FILE.bak"

echo "Patched $FILE: POOL_INIT_CODE_HASH -> $NEW_HASH"
echo "Now run: FOUNDRY_PROFILE=v3 forge build --use 0.7.6"
