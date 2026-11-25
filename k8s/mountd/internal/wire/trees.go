// Package wire is what mountd, the arborist and sandbox-bind exchange: the
// trees mountd asks the arborist for, the binds it hands sandbox-bind, and
// the JSON answers both daemons give.
package wire

import (
	"fmt"
	"regexp"
)

var (
	// IDPattern is a repo id, and the shape of any name a request gives
	// that becomes one path segment.
	IDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	commitPattern = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})?$`)
)

// TreeKey names a working tree the arborist builds and mountd takes: a
// repo, by its id, at a commit.
type TreeKey struct {
	Repo   string `json:"repo"`
	Commit string `json:"commit"`
}

// Check refuses a key that is no repo id and object id.
func (k TreeKey) Check() error {
	if !IDPattern.MatchString(k.Repo) {
		return fmt.Errorf("repo %q is not a repo id", k.Repo)
	}
	if !commitPattern.MatchString(k.Commit) {
		return fmt.Errorf("commit %q is not an object id", k.Commit)
	}
	return nil
}
