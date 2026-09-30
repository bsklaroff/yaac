# Calico pin

`yaac cluster install` installs Calico as the CNI and NetworkPolicy engine,
from upstream's release manifest (the classic KDD/iptables one). The repo
holds only the manifest's checksum, not the manifest. Install downloads it
once from
`raw.githubusercontent.com/projectcalico/calico/v<version>/manifests/calico.yaml`,
checks it against `calico.yaml.sha256`, and caches it at
`~/.yaac-client/cache/calico-<version>.yaml` (beside the data dir). A checksum
mismatch fails the install. This pins the version as tightly as a vendored
copy without carrying about 350 KB of upstream YAML in the repo and the npm
package.

To upgrade, bump `CALICO_VERSION` in
`packages/server/src/drivers/k8s/install/install.ts` and repin:

```sh
curl -fsSL https://raw.githubusercontent.com/projectcalico/calico/v<version>/manifests/calico.yaml \
  | shasum -a 256 | sed 's|-$|calico.yaml|' > k8s/calico/calico.yaml.sha256
```

Nothing else changes: install reads the list of images to preload onto the
node from the manifest itself.
