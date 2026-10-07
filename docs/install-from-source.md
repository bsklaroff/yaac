# Installing from source

A source install and the brew one both own the `bin/yaac` link, so run
`brew uninstall yaac` first if you have it. To switch back later:
`npm uninstall -g @bsklaroff/yaac && brew install bsklaroff/yaac/yaac`.

## macOS (arm64)

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew tap libkrun/krun
brew install node pnpm kubernetes-cli podman kind bsklaroff/yaac/yaac-krunkit
brew install tmux socat fd ripgrep   # for the containerless driver

# Download and install yaac
git clone https://github.com/bsklaroff/yaac.git && cd yaac
pnpm install && pnpm build
npm install -g .      # links the checkout, so every pnpm build is live
yaac cluster install  # or: yaac server start
```

## Linux (Debian/Ubuntu)

For k8s, add swap before the first install; see
[cluster-setup.md](cluster-setup.md#linux-swap).

```sh
sudo apt install podman acl libgomp1
sudo apt install tmux socat fd-find ripgrep   # for the containerless driver

# Node from nvm: apt's build lacks the type stripping `vite build` needs.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh"
nvm install 24.21.0 && nvm alias default 24.21.0
npm install -g pnpm

curl -fsSLo kind "https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-$(dpkg --print-architecture)"
sudo install -m 755 kind /usr/local/bin/kind && rm kind
curl -fsSLo kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl"
sudo install -m 755 kubectl /usr/local/bin/kubectl && rm kubectl

# yaac uses rootful podman on Linux.
sudo systemctl enable --now podman.socket
sudo setfacl -m u:$USER:x /run/podman
sudo setfacl -m u:$USER:rw /run/podman/podman.sock

# Download and install yaac
git clone https://github.com/bsklaroff/yaac.git && cd yaac
pnpm install && pnpm build
npm install -g .      # links the checkout, so every pnpm build is live
yaac cluster install  # or: yaac server start
```

apt's podman 5.x is fine. yaac uses the rootful engine because kind's node
needs host netfilter and routing access that rootless podman doesn't grant
([cluster-setup.md](cluster-setup.md#linux-rootful-podman)). Node comes from
nvm because Debian and Ubuntu build `nodejs` without type stripping, so
`pnpm build` fails at `vite build` with `ERR_NO_TYPESCRIPT`.
