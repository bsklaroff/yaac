package wire

import (
	"strings"
	"testing"
)

func TestByDepth(t *testing.T) {
	got := ByDepth([]Bind{{Target: "/workspace/a/.git"}, {Target: "/home/yaac/.claude/projects"}, {Target: "/workspace"}, {Target: "/home/yaac/.claude"}})
	order := []string{}
	for _, b := range got {
		order = append(order, b.Target)
	}
	if strings.Join(order, ",") != "/workspace,/workspace/a/.git,/home/yaac/.claude,/home/yaac/.claude/projects" {
		t.Errorf("order %v", order)
	}
}
