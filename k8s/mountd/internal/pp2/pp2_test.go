package pp2

import (
	"bytes"
	"encoding/hex"
	"io"
	"net/netip"
	"testing"
)

// The same bytes are asserted by k8s/proxy/test/socket-ingress.test.ts, so
// the Go writers and the proxy's reader agree.
const (
	netshimHex = "0d0a0d0a000d0a515549540a2111000c7f0000018c5270039c4001bb"
	relayHex   = "0d0a0d0a000d0a515549540a2111001c7f0000018c5270039c4001bbe0000477732d31e10006733363726574"
)

var (
	src = netip.MustParseAddrPort("127.0.0.1:40000")
	dst = netip.MustParseAddrPort("140.82.112.3:443")
)

func TestVectors(t *testing.T) {
	for name, c := range map[string]struct {
		hex string
		h   Header
	}{
		"netshim": {netshimHex, Header{Src: src, Dst: dst}},
		"relay":   {relayHex, Header{Src: src, Dst: dst, TLVs: []TLV{{TLVID, []byte("ws-1")}, {TLVSecret, []byte("s3cret")}}}},
	} {
		got, err := c.h.Encode()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if hex.EncodeToString(got) != c.hex {
			t.Errorf("%s: encoded %x", name, got)
		}
		raw, _ := hex.DecodeString(c.hex)
		r := bytes.NewReader(append(raw, "rest"...))
		h, err := Read(r)
		if err != nil {
			t.Fatalf("%s: read: %v", name, err)
		}
		if h.Src != src || h.Dst != dst || len(h.TLVs) != len(c.h.TLVs) {
			t.Errorf("%s: read %+v", name, h)
		}
		for i, v := range c.h.TLVs {
			if h.TLVs[i].Type != v.Type || !bytes.Equal(h.TLVs[i].Value, v.Value) {
				t.Errorf("%s: TLV %d is %+v", name, i, h.TLVs[i])
			}
		}
		rest, _ := io.ReadAll(r)
		if string(rest) != "rest" {
			t.Errorf("%s: read past the header, left %q", name, rest)
		}
	}
	raw, _ := hex.DecodeString(relayHex)
	h, _ := Read(bytes.NewReader(raw))
	if id, ok := h.TLV(TLVID); !ok || string(id) != "ws-1" {
		t.Errorf("TLV lookup: %q %v", id, ok)
	}
}

func TestRefused(t *testing.T) {
	good, _ := hex.DecodeString(relayHex)
	mutate := func(f func(b []byte) []byte) []byte { return f(append([]byte(nil), good...)) }
	for name, b := range map[string][]byte{
		"empty":         nil,
		"short":         good[:10],
		"no signature":  mutate(func(b []byte) []byte { b[0] = 'G'; return b }),
		"version 1":     mutate(func(b []byte) []byte { b[12] = 0x11; return b }),
		"command 2":     mutate(func(b []byte) []byte { b[12] = 0x22; return b }),
		"family unix":   mutate(func(b []byte) []byte { b[13] = 0x31; return b }),
		"too long":      mutate(func(b []byte) []byte { b[14], b[15] = 0x04, 0x01; return b }),
		"truncated":     good[:len(good)-1],
		"partial TLV":   mutate(func(b []byte) []byte { b[15] -= 1; return b[:len(b)-1] }),
		"TLV overruns":  mutate(func(b []byte) []byte { b[len(b)-7] = 0x09; return b }),
		"short address": mutate(func(b []byte) []byte { b[14], b[15] = 0, 4; return b[:20] }),
	} {
		if _, err := Read(bytes.NewReader(b)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLocalAndUnspec(t *testing.T) {
	// A LOCAL header over IPv4 with a site TLV, as Envoy may write it.
	b := append([]byte(nil), Signature...)
	b = append(b, 0x20, 0x11, 0, 12+7)
	b = append(b, make([]byte, 12)...)
	b = append(b, TLVID, 0, 4, 's', 'i', 't', 'e')
	h, err := Read(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if h.Src.IsValid() {
		t.Errorf("LOCAL kept addresses: %v", h.Src)
	}
	if v, _ := h.TLV(TLVID); string(v) != "site" {
		t.Errorf("TLV %q", v)
	}
	u := append(append([]byte(nil), Signature...), 0x21, 0x00, 0, 0)
	if _, err := Read(bytes.NewReader(u)); err != nil {
		t.Errorf("UNSPEC: %v", err)
	}
	v6 := append(append([]byte(nil), Signature...), 0x21, 0x21, 0, 36)
	v6 = append(v6, make([]byte, 36)...)
	if _, err := Read(bytes.NewReader(v6)); err != nil {
		t.Errorf("IPv6: %v", err)
	}
	if _, err := (&Header{Src: netip.MustParseAddrPort("[::1]:1"), Dst: dst}).Encode(); err == nil {
		t.Error("encoded IPv6")
	}
}
