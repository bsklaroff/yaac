package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"yaac-mountd/internal/wire"
)

func validRequest() bindRequest {
	return bindRequest{
		Token:       "t",
		Pod:         "yaac-w-abcde",
		WorkspaceID: "w",
		Dir:         "w.0011aabb",
		Life:        "2026-11-24T21-00-00.000Z",
		Trees:       []treeTake{{TreeKey: wire.TreeKey{Repo: "r1", Commit: strings.Repeat("a", 40)}, Dest: "projects/p/trees/w/l/tree", Index: "projects/p/trees/w/l/scratch/arborist/r1.index"}},
		Dirs:        []string{"projects/p/trees/w/l/scratch"},
		Mounts:      []bindMount{{Tier: "shared", Path: "projects/p/claude", Workspace: "/home/yaac/.claude"}},
		Folders:     []folderBind{{From: "scratch", Target: "/workspace/node_modules"}},
		Roots:       map[string]string{"scratch": "/yaac-scratch"},
	}
}

func TestBindRequestCheck(t *testing.T) {
	if err := (&bindRequest{}).check(); err == nil {
		t.Error("an empty request passed")
	}
	ok := validRequest()
	if err := ok.check(); err != nil {
		t.Fatalf("a good request refused: %v", err)
	}
	bad := map[string]func(*bindRequest){
		"dir with a slash":       func(r *bindRequest) { r.Dir = "a/b" },
		"tree dest escapes":      func(r *bindRequest) { r.Trees[0].Dest = "../etc" },
		"tree dest absolute":     func(r *bindRequest) { r.Trees[0].Dest = "/etc" },
		"commit not an id":       func(r *bindRequest) { r.Trees[0].Commit = "HEAD" },
		"repo id with a slash":   func(r *bindRequest) { r.Trees[0].Repo = "a/b" },
		"folder of no volume":    func(r *bindRequest) { r.Folders[0].From = "elsewhere" },
		"mount path escapes":     func(r *bindRequest) { r.Mounts[0].Path = "a/../../b" },
		"target relative":        func(r *bindRequest) { r.Mounts[0].Workspace = "home/yaac" },
		"target unclean":         func(r *bindRequest) { r.Mounts[0].Tree = "/a/../b" },
		"node-local dir escapes": func(r *bindRequest) { r.Dirs[0] = "../x" },
	}
	for name, mutate := range bad {
		r := validRequest()
		mutate(&r)
		if err := r.check(); err == nil {
			t.Errorf("%s: passed", name)
		}
	}
}

func TestAuthorized(t *testing.T) {
	m := &mounter{cfg: config{token: "secret", arboristURL: "http://127.0.0.1:1"}, http: &http.Client{}, stuck: map[string]string{}}
	h := m.handler()
	for header, want := range map[string]int{"": 401, "Bearer wrong": 401, "secret": 401, "Bearer secret": 200} {
		req := httptest.NewRequest(http.MethodGet, "/report", nil).WithContext(context.Background())
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("%q: %d, want %d", header, rec.Code, want)
		}
	}
}
