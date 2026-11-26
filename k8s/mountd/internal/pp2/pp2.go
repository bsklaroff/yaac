// Package pp2 reads and writes PROXY protocol v2 headers, the framing every
// hop of the socket datapath puts in front of a connection
// (docs/workspace-egress.md "Wire formats"): netshim names the address a
// sandbox dialed, the relay adds the sandbox's id and the proxy auth secret,
// and the site router names a site. The proxy's k8s/proxy/pp2.ts parses the
// same bytes.
package pp2

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/netip"
)

// TLV types yaac adds: the sandbox's (or site's) id, and the proxy auth
// secret. Both sit in the range the spec leaves to applications.
const (
	TLVID     = 0xE0
	TLVSecret = 0xE1
)

// MaxBody caps the part of a header after its fixed 16 bytes, so a hostile
// length cannot make a reader buffer much.
const MaxBody = 1024

// Signature opens every v2 header.
var Signature = []byte{0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a}

// TLV is one type-length-value entry after the addresses.
type TLV struct {
	Type  byte
	Value []byte
}

// Header is a parsed header. Src and Dst are zero when the header carries
// no addresses (a LOCAL command, or family UNSPEC).
type Header struct {
	Src, Dst netip.AddrPort
	TLVs     []TLV
}

// TLV returns the value of the first entry of type t.
func (h *Header) TLV(t byte) ([]byte, bool) {
	for _, v := range h.TLVs {
		if v.Type == t {
			return v.Value, true
		}
	}
	return nil, false
}

// Encode writes the header as a PROXY command over TCP on IPv4, with its
// TLVs in order. Src and Dst must be IPv4.
func (h *Header) Encode() ([]byte, error) {
	if !h.Src.Addr().Is4() || !h.Dst.Addr().Is4() {
		return nil, errors.New("pp2: only IPv4 addresses are encoded")
	}
	n := 12
	for _, t := range h.TLVs {
		if len(t.Value) > 0xffff {
			return nil, errors.New("pp2: TLV too long")
		}
		n += 3 + len(t.Value)
	}
	if n > MaxBody {
		return nil, errors.New("pp2: header too long")
	}
	b := make([]byte, 0, 16+n)
	b = append(b, Signature...)
	b = append(b, 0x21, 0x11)
	b = binary.BigEndian.AppendUint16(b, uint16(n))
	src, dst := h.Src.Addr().As4(), h.Dst.Addr().As4()
	b = append(b, src[:]...)
	b = append(b, dst[:]...)
	b = binary.BigEndian.AppendUint16(b, h.Src.Port())
	b = binary.BigEndian.AppendUint16(b, h.Dst.Port())
	for _, t := range h.TLVs {
		b = append(b, t.Type)
		b = binary.BigEndian.AppendUint16(b, uint16(len(t.Value)))
		b = append(b, t.Value...)
	}
	return b, nil
}

// Read reads one header from r, consuming exactly its bytes and nothing
// after them, so the stream that follows is left for the caller.
func Read(r io.Reader) (*Header, error) {
	fixed := make([]byte, 16)
	if _, err := io.ReadFull(r, fixed); err != nil {
		return nil, fmt.Errorf("pp2: %w", err)
	}
	if !bytes.Equal(fixed[:12], Signature) {
		return nil, errors.New("pp2: no signature")
	}
	if fixed[12]>>4 != 2 {
		return nil, errors.New("pp2: not version 2")
	}
	cmd := fixed[12] & 0x0f
	if cmd != 0 && cmd != 1 {
		return nil, errors.New("pp2: unknown command")
	}
	n := int(binary.BigEndian.Uint16(fixed[14:16]))
	if n > MaxBody {
		return nil, errors.New("pp2: header too long")
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, fmt.Errorf("pp2: %w", err)
	}
	h := &Header{}
	off := 0
	switch fixed[13] {
	case 0x00:
	case 0x11:
		if n < 12 {
			return nil, errors.New("pp2: short IPv4 addresses")
		}
		h.Src = netip.AddrPortFrom(netip.AddrFrom4([4]byte(body[0:4])), binary.BigEndian.Uint16(body[8:10]))
		h.Dst = netip.AddrPortFrom(netip.AddrFrom4([4]byte(body[4:8])), binary.BigEndian.Uint16(body[10:12]))
		off = 12
	case 0x21:
		if n < 36 {
			return nil, errors.New("pp2: short IPv6 addresses")
		}
		h.Src = netip.AddrPortFrom(netip.AddrFrom16([16]byte(body[0:16])), binary.BigEndian.Uint16(body[32:34]))
		h.Dst = netip.AddrPortFrom(netip.AddrFrom16([16]byte(body[16:32])), binary.BigEndian.Uint16(body[34:36]))
		off = 36
	default:
		return nil, fmt.Errorf("pp2: unsupported family %#x", fixed[13])
	}
	if cmd == 0 {
		h.Src, h.Dst = netip.AddrPort{}, netip.AddrPort{}
	}
	for off < n {
		if off+3 > n {
			return nil, errors.New("pp2: partial TLV")
		}
		t, l := body[off], int(binary.BigEndian.Uint16(body[off+1:off+3]))
		off += 3
		if off+l > n {
			return nil, errors.New("pp2: partial TLV")
		}
		h.TLVs = append(h.TLVs, TLV{Type: t, Value: body[off : off+l]})
		off += l
	}
	return h, nil
}
