#!/usr/bin/env bash
#
# Arcade — one-shot dev bootstrap for a fresh machine.
#
# Run it either:
#   * standalone (it clones the repo):   bash setup.sh
#   * or from inside an existing clone:  bash setup.sh
#
# It does everything a script CAN do (clone, branch, submodules, the mandatory
# v3-periphery init-hash patch, forge build, npm installs). It CANNOT create
# web/.env.local — those are secrets; see the printed TODO at the end.
#
set -euo pipefail

REPO_URL="https://github.com/obseasd/Arcade.git"
BRANCH="feat/pair-level-fee"

say() { printf "\n\033[1;36m== %s ==\033[0m\n" "$1"; }
die() { printf "\n\033[1;31m!! %s\033[0m\n" "$1"; exit 1; }

say "Arcade dev bootstrap"

# --- 0. Prerequisites (the script does NOT install these) ---
command -v git   >/dev/null || die "git manquant."
command -v node  >/dev/null || die "node manquant. Installe Node 24.x (nvm install 24 && nvm use 24)."
command -v npm   >/dev/null || die "npm manquant."
command -v forge >/dev/null || die "foundry manquant. curl -L https://foundry.paradigm.xyz | bash && foundryup"
NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
[ "${NODE_MAJOR}" -ge 20 ] || echo "   (avertissement) Node ${NODE_MAJOR} detecte; le projet cible 24.x."

# --- 1. Clone if we're not already inside the repo ---
if [ ! -f "contracts/foundry.toml" ]; then
  say "Clone"
  git clone "${REPO_URL}" Arcade
  cd Arcade
fi

say "Branche ${BRANCH}"
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}" || echo "   (pas de fast-forward — local en avance ou hors-ligne, on continue)"

# --- 2. Submodules (Uniswap v3/v4 core+periphery; forge-std/oz are vendored) ---
say "Submodules"
git submodule update --init --recursive

# --- 3. Contracts: patch v3-periphery init hash (MANDATORY), then build ---
say "Contrats (patch v3-periphery + forge build)"
( cd contracts \
  && bash scripts/patch-v3-periphery.sh \
  && forge build )

# --- 4. Web deps ---
say "Web (npm install)"
( cd web && npm install )

# --- 5. Subgraph deps ---
if [ -d "subgraph" ]; then
  say "Subgraph (npm install)"
  ( cd subgraph && npm install )
fi

# --- Done ---
say "OK — installe termine"
cat <<'TODO'

RESTE A FAIRE MANUELLEMENT (le script ne peut pas, ce sont des secrets) :

  1. Les 58 variables d'env de web/.env.local (RPC keys, cles keeper/backend,
     KEEPER_CRON_SECRET, URL Neon, URL Goldsky...). Le plus propre :
        cd web
        vercel link                 # lie le dossier au projet Vercel
        vercel env pull .env.local  # telecharge tous les secrets
     (sinon copie ton web/.env.local via un canal CHIFFRE — jamais en clair,
      il contient des cles privees. Template des noms : web/.env.local.example)

  2. Lancer :
        cd web && npm run dev        # http://localhost:3000

RAPPELS :
  - NE PAS faire 'npm run build' dans web/ si 'npm run dev' tourne (corrompt .next).
    Verifie les types avec: npx tsc --noEmit
  - Le patch v3-periphery est a re-appliquer apres tout 'git submodule update'
    ou 'forge install' (re-lance juste ce script, il est idempotent).
TODO
