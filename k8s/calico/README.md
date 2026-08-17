# Calico pin

`yaac cluster install` installs Calico as the CNI + NetworkPolicy engine from
upstream's classic KDD/iptables release manifest. The manifest is *not*
vendored — only its checksum is. Setup downloads it once
(`raw.githubusercontent.com/projectcalico/calico/v<version>/manifests/calico.yaml`),
verifies it against `calico.yaml.sha256`, and caches the verified bytes at
`$YAAC_DATA_DIR/cache/calico-<version>.yaml`; a mismatch is a fatal setup
error, never a warning. So the install is pinned as tightly as a vendored
copy without carrying 350 KB of upstream YAML in the repo and the npm
artifact.

To move to a new version, bump `CALICO_VERSION` in
`packages/server/src/drivers/k8s/cluster/setup.ts` and repin:

```sh
curl -fsSL https://raw.githubusercontent.com/projectcalico/calico/v<version>/manifests/calico.yaml \
  | shasum -a 256 | sed 's|-$|calico.yaml|' > k8s/calico/calico.yaml.sha256
```

Nothing else needs editing: the image set setup preloads onto the node is
parsed out of the manifest, so it follows the new version on its own.
