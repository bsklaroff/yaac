#!/bin/sh
set -e

# Setup script to install git hooks

echo "Setting up git hooks..."

# Resolve the actual git dir (handles worktrees where .git is a file)
GIT_DIR="$(git rev-parse --git-dir)"

# Create hooks directory if it doesn't exist
mkdir -p "$GIT_DIR/hooks"

# Get the absolute path to the .githooks directory
HOOKS_DIR="$(cd "$(dirname "$0")/.githooks" && pwd)"

# Create symlinks for all hooks from .githooks to .git/hooks
for hook in .githooks/*; do
    if [ -f "$hook" ]; then
        hook_name=$(basename "$hook")
        # Create symlink with -f flag to force overwrite
        ln -sf "$HOOKS_DIR/$hook_name" "$GIT_DIR/hooks/$hook_name"
        echo "✅ Linked $hook_name"
    fi
done

echo "Git hooks setup complete!"
