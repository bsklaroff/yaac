#!/bin/bash
set -euo pipefail

export NVM_DIR="$HOME/.nvm"

curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. "$NVM_DIR/nvm.sh"
cd /workspace
nvm install
corepack enable
corepack prepare pnpm@10.7.0 --activate
ln -s "$NVM_DIR/versions/node/v$(cat /workspace/.nvmrc)" "$NVM_DIR/current"
