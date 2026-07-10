#!/bin/sh
# Vendor the pinned vcluster Helm chart tarball into k8s/vcluster/. Run
# this ONLY when upgrading the chart: bump k8s/vcluster/VERSION (and
# k8s/vcluster/images.json to match), then re-run. At runtime yaac shells
# out to `helm template` against this vendored tarball (offline) and
# applies the result — see renderVclusterManifests in
# packages/server/src/lib/k8s/vcluster.ts. There is no rendered manifests.yaml anymore;
# per-session values are passed as `--set` overrides at render time.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VCLUSTER_DIR="${SCRIPT_DIR}/../k8s/vcluster"
VERSION="$(tr -d '[:space:]' < "${VCLUSTER_DIR}/VERSION")"

if ! command -v helm >/dev/null 2>&1; then
  echo "helm not found on PATH — install helm to re-vendor the chart" >&2
  exit 1
fi

# Drop any stale vendored tarball so an old version can't linger.
rm -f "${VCLUSTER_DIR}"/vcluster-*.tgz
helm pull vcluster \
  --repo https://charts.loft.sh \
  --version "${VERSION}" \
  -d "${VCLUSTER_DIR}"

echo "Vendored vcluster ${VERSION} -> ${VCLUSTER_DIR}/vcluster-${VERSION}.tgz"
echo "Reminder: keep k8s/vcluster/{values.yaml,images.json} in sync with this chart."
