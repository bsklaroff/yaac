// What mountd hands `sandbox-bind`, the program that binds a pod's
// node-mounts entries inside its sandbox (docs/generic-workspace-pods.md
// "A claim").

package wire

import (
	"path/filepath"
	"sort"
	"strings"
)

// NodeMountsDir is where both of a pod's containers see its node-mounts
// directory.
const NodeMountsDir = "/node-mounts"

// ListFile is the list mountd writes into a pod's node-mounts directory once
// its entries are in place.
const ListFile = "list.json"

// Helper is the name `sandbox-bind` has in a pod's node-mounts directory,
// from which the tree container runs it.
const Helper = "sandbox-bind"

// Bind is one bind inside a sandbox: node-mounts entry N, or with From set
// folder N of that pod-local volume (the scratch volume, or the one for
// `emptyDir` asks), onto Target.
type Bind struct {
	N        int    `json:"n"`
	From     string `json:"from,omitempty"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

// Request is `sandbox-bind binds`' argument: the workspace container's binds.
type Request struct {
	Binds []Bind `json:"binds"`
	// Each pod-local volume's mount point, and who owns the folders made
	// in them.
	Roots map[string]string `json:"roots,omitempty"`
	UID   int               `json:"uid"`
	GID   int               `json:"gid"`
}

// List is the list file: what the tree container binds, and the life it
// serves.
type List struct {
	Life string `json:"life"`
	Tree []Bind `json:"tree"`
}

// ByDepth orders binds so each lands after any bind that holds its target.
func ByDepth(binds []Bind) []Bind {
	out := append([]Bind(nil), binds...)
	sort.SliceStable(out, func(i, j int) bool {
		return strings.Count(filepath.Clean(out[i].Target), "/") < strings.Count(filepath.Clean(out[j].Target), "/")
	})
	return out
}
