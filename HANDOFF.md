# Arcade — Handoff (nouveau PC + contexte Claude)

Dernière mise à jour : 2026-07-29. Branche active : **`feat/pair-level-fee`** (tenue en phase avec `main`). Repo : `github.com/obseasd/Arcade`. Prod : `www.arcade.trading` (Vercel, suit `main`). Chaînes : Arc **testnet 5042002** (actif) + **mainnet 5042** (scaffoldé, pas encore basculé).

---

## 1. Monter le projet sur le nouveau PC

**Prérequis (à installer d'abord, le script ne les installe pas) :**
```sh
nvm install 24 && nvm use 24                                   # Node 24.x (Next 15)
curl -L https://foundry.paradigm.xyz | bash && foundryup       # Foundry (forge/cast)
# git : déjà présent en général
```

**Bootstrap (fait clone + submodules + patch v3-periphery + forge build + npm installs) :**
```sh
git clone https://github.com/obseasd/Arcade.git && cd Arcade
git checkout feat/pair-level-fee
bash setup.sh                # idempotent, re-lançable
```
> `setup.sh` peut aussi être lancé standalone (il clone lui-même) — voir le fichier.

**Secrets (les 58 vars de `web/.env.local`, impossibles à scripter) :**
```sh
cd web
vercel link                  # lie au projet Vercel (npm i -g vercel si besoin)
vercel env pull .env.local   # télécharge tous les secrets d'un coup
```
Sinon copie ton `web/.env.local` via un canal **chiffré** (il contient des clés privées). Template des noms : `web/.env.local.example`.

**Lancer :**
```sh
cd web && npm run dev        # http://localhost:3000
cd contracts && forge test   # contrats
```

⚠️ **Jamais `npm run build` dans web/** pendant qu'un `npm run dev` tourne (corrompt `.next`) → vérifie les types avec `npx tsc --noEmit`. Le patch v3-periphery est à re-appliquer après tout `git submodule update` → re-lance `bash setup.sh`.

---

## 2. Récupérer le contexte Claude Code sur le nouveau PC

Claude range tout par **chemin absolu encodé** du projet. Sur ce PC :
`~/.claude/projects/c--Users-Asus-Desktop-Projet-Crypto-Arcade/`
- `memory/` — **53 fichiers** = la connaissance durable du projet (chargée à chaque session). **C'est le plus important à transférer.**
- `d2864d0d-5189-4017-ae0f-95d23b27287d.jsonl` — le transcript de CETTE session.

**Comme le chemin (donc le nom du dossier) sera différent sur le nouveau PC :**
1. Lance Claude Code **une fois** dans le projet sur le nouveau PC → il crée `~/.claude/projects/<nouveau-nom-encodé>/`.
2. **Copie la `memory/`** de l'ancien dossier vers ce nouveau dossier. → Claude a tout le contexte projet.
3. (Optionnel) copie le `.jsonl` dedans puis `claude --resume` pour reprendre cette conversation exacte (peut avoir des quirks cross-machine ; la `memory/` + ce HANDOFF sont les vecteurs fiables).

> Astuce : si tu mets le projet au **même chemin relatif** et gardes le même nom d'utilisateur, le nom de dossier peut coïncider et Claude retrouve tout automatiquement. Sinon, la copie manuelle ci-dessus.

**Règle mémoire n°1** : `web/public/deployments.json` est la SEULE source de vérité des adresses déployées. Toute adresse dans un fichier mémoire peut être périmée — vérifie on-chain avant d'agir.

---

## 3. État du projet (au 2026-07-29)

**Ce qui tourne :**
- **Contrats testnet** (voir `deployments.json`) : FeeProtocolManager `0xE1F23B9E37A7eE926E2B56Ab88C2509C77fFeb7a` (owner+treasury = Safe 2-of-3 `0x0bDE09e3`, owne le v3Factory `0x7E875574`), arcadeHook `0x6f10738025aA084f90A47cE7B0baCef6f1f63ECe` (V4, **déployé** et en production ; le flux "Launch a token" route vers `/launchpad/v4hook/create` et appelle `createLaunch`), v3Zap `0x7a38abe2`, etc.
- **Keeper** `web/app/api/keeper/cron` (cron-job.org toutes les 2 min) : leg A (Orbs limit/DCA), leg B (CCTP relay), leg C (auto-sync V3 feeProtocol **+ auto-collect** vers treasury). **Fonctionnel end-to-end** (prouvé : pool sync auto 0→102). + `web/app/api/keeper/sync-pool` = activation on-demand (gap ~2-6min → ~secondes).
- **Subgraph** Goldsky `arcade-charts` (tag `prod`), lag **~1 bloc** (Goldsky a tuné, mainnet couvert). URL dans `GOLDSKY_SETUP.md`.

**Ce qui a été fait cette session (commits, du plus récent) :**
- `718cccb` setup.sh · `ad8e8c6` keeper sync-pool on-demand · `1427789` keeper auto-collect protocol fees
- `f389d4a` **keeper: signature compte local (LE bug racine — le keeper n'envoyait aucun tx)** · `a423adf`→`470151e`→`7d4ea39` chaîne de fixes keeper (pre-check rapide, fenêtre 10k, arc.network-first, fallback RPC, self-healing) · `6ef2cc8` feeProtocolManager dans deployments.json
- `e90afd2` zap price-impact via vrai quoter · `1fd0815` MC des CLANKER V4 · `bc92a25` 2 recipients sur reply-launch · `c8c63f6` subgraph SPOT price V4 curve · `6b91efd` price-impact parallèle · `be45b33` fix ABI zap (sqrtPriceX96)

**Découvertes clés (voir memory) :** le RPC **thirdweb cap getLogs à 1000 blocs** (arc.network gère 10k) ; viem **writeContract avec une adresse → `wallet_sendTransaction` que Arc rejette** → toujours passer l'objet compte (`walletClient.account!`).

**En attente / TODO :**
1. **Roter** `KEEPER_CRON_SECRET` + la clé deployer `0x3a0Dd9` (exposés en clair pendant la session).
2. Rotation du signer escrow Twitter → prévue **au passage mainnet** (2 tx Safe + env Vercel).
3. **Basculer mainnet** : voir `MAINNET_SWITCH.md` (`NEXT_PUBLIC_ARC_ENV=mainnet`, deploy gen, seed liquidité, attestation CCTP).
4. Optionnel : wallet keeper **dédié** `0xC3D6ED473B2D22908d1CBc45e74ABa1133BD4107` (inutilisé, nonce 0) pour isoler le nonce de ta Rabby.
5. `collectProtocol` treasury = manuel avant, **maintenant auto** (keeper ~30min) ; vérifier que ça balaye bien après le prochain deploy.

**Gotchas récurrents :** deployments.json = vérité des adresses ; jamais d'em-dash dans les outputs ; patch v3-periphery après forge install ; getLogs Arc borné (≤10k arc.network, ≤1000 thirdweb) et re-filtrer les topics en JS.
