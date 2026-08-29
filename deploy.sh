#!/usr/bin/env bash
#
# Déploie sly-crm sur le VPS — en garantissant que ce qui part en prod
# est versionné, et qu'aucun fichier de production n'est effacé au passage.
#
# POURQUOI CE SCRIPT EXISTE
# Deux problèmes réels qu'il empêche de reproduire :
#
# 1. Le déploiement passe par rsync, jamais par git. Rien n'oblige donc à
#    commiter, et 44 fichiers — fiche d'atelier, module Produits, marges,
#    grille de tailles, étapes de production — sont restés hors de git
#    jusqu'au 29/08/2026, sur une seule machine.
#
# 2. Le 04/08/2026, un `rsync --delete` sans `--exclude .env` a EFFACÉ le
#    .env de production : clés Stripe live, secrets de webhook, clés Resend.
#    Aucune copie locale n'existait (le .env est gitignoré). Récupéré de
#    justesse parce que le conteneur encore en vie portait les valeurs dans
#    son environnement de processus.
#
# D'où l'ordre imposé — commit → push → vérification des suppressions →
# rsync → rebuild — et le garde-fou qui refuse de continuer si rsync
# s'apprête à supprimer un .env ou une base de données.
#
# USAGE
#   ./deploy.sh "message de commit"

set -euo pipefail
cd "$(dirname "$0")"

APP="sly-crm"
REMOTE="root@76.13.53.46"
REMOTE_PATH="/docker/${APP}/"
SSH_KEY="$HOME/.ssh/hostinger_vps"
MESSAGE="${1:-Déploiement du $(date '+%Y-%m-%d %H:%M')}"

# --exclude .env n'est PAS optionnel : voir le point 2 de l'en-tête.
# *.db* protège la base de production, qui ne doit jamais être écrasée
# par la base de développement locale.
EXCLUDES=(
  --exclude node_modules
  --exclude .git
  --exclude .claude
  --exclude '*.db*'
  --exclude 'frontend/dist'
  --exclude .env
)

echo "▸ 1/4  Commit"
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git commit -q -m "$MESSAGE"
  echo "   commité : $(git log -1 --format='%h %s')"
else
  echo "   rien à commiter, arbre propre"
fi

echo "▸ 2/4  Push"
if git remote get-url origin >/dev/null 2>&1; then
  git push origin HEAD
  echo "   poussé sur $(git remote get-url origin)"
else
  echo "   ⚠️  AUCUN DÉPÔT DISTANT — le code n'existe que sur ce Mac."
  echo "   Crée un dépôt PRIVÉ sur github.com puis :"
  echo "      git remote add origin git@github.com:lucgerbet/${APP}.git"
  echo "      git push -u origin main"
fi

echo "▸ 3/4  Vérification des suppressions distantes"
# Garde-fou : on regarde ce que --delete supprimerait AVANT de le faire.
DELETIONS=$(rsync -az --delete --dry-run "${EXCLUDES[@]}" \
  -e "ssh -i ${SSH_KEY}" ./ "${REMOTE}:${REMOTE_PATH}" \
  | grep '^deleting ' || true)

if [[ -n "$DELETIONS" ]]; then
  echo "$DELETIONS" | sed 's/^/   /'
  if echo "$DELETIONS" | grep -qE '\.env|\.db'; then
    echo
    echo "   ⛔ ARRÊT — rsync s'apprête à supprimer un .env ou une base de données"
    echo "   sur la PRODUCTION. C'est exactement l'incident du 04/08/2026."
    echo "   Corrige la liste d'exclusions avant de relancer."
    exit 1
  fi
  echo "   (suppressions sans danger)"
else
  echo "   aucune suppression"
fi

echo "▸ 4/4  Envoi et reconstruction"
rsync -az --delete "${EXCLUDES[@]}" -e "ssh -i ${SSH_KEY}" ./ "${REMOTE}:${REMOTE_PATH}"
# up -d --build (et non docker cp + restart) : un changement de label Traefik
# n'est lu qu'à la création du conteneur.
ssh -i "${SSH_KEY}" "${REMOTE}" "cd /docker/${APP} && docker compose up -d --build"

echo "✅ Terminé — https://sly-crm.srv1758374.hstgr.cloud"
