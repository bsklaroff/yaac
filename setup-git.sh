#!/bin/sh
set -e

# Setup script to install git hooks

# Dev-only: runs via the package.json `prepare` hook. Consumer installs
# (npm tarball) never run it, but `npm pack`/`prepare` in an exported
# source tree would — skip quietly when there is no enclosing repo.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "Not inside a git repository; skipping git hooks setup."
    exit 0
fi

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
