#!/bin/sh

# Setup script to install git hooks

echo "Setting up git hooks..."

# Create hooks directory if it doesn't exist
mkdir -p .git/hooks

# Get the absolute path to the .githooks directory
HOOKS_DIR="$(cd "$(dirname "$0")/.githooks" && pwd)"

# Create symlinks for all hooks from .githooks to .git/hooks
for hook in .githooks/*; do
    if [ -f "$hook" ]; then
        hook_name=$(basename "$hook")
        # Create symlink with -f flag to force overwrite
        ln -sf "$HOOKS_DIR/$hook_name" ".git/hooks/$hook_name"
        echo "✅ Linked $hook_name"
    fi
done

echo "Git hooks setup complete!"
