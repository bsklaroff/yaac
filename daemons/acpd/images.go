// Images in the record.
//
// A screenshot is megabytes of base64, and the agent repeats it in more than
// one field of a tool result, so a few dozen would fill the record past what
// the server reads. Each long line is parsed, and every `data` or `base64`
// string in it that decodes to a PNG, JPEG, GIF or WebP is written to
// `images/<sha256>` beside the record and replaced by `yaac-image:<sha256>`.
// `data` is where ACP and Anthropic blocks carry an image, and `base64` is
// claude's `_meta.claudeCode.toolResponse.file` copy. Other keys, and the
// `data` of codex's and pi's `_meta.terminal_output*` shell output, are left
// alone even when they hold image base64, because the pane renders them as
// text (a Write's diff, a pasted prompt, `base64 shot.png`). The server
// serves the image from there. The relayed bytes are unchanged; only the
// record differs, and in it only the replaced strings. A line that fails to
// parse, or an image that cannot be stored, is recorded as it came.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	// Lines shorter than this are recorded unparsed: an image worth storing
	// apart makes its line at least this long.
	imageLineBytes = 16 * 1024
	// The shortest base64 string stored as an image (about 6 KB decoded).
	imageDataChars = 8 * 1024
	// What an image's string becomes in the record; base64 has no `:`, so
	// it cannot be mistaken for image data.
	imageRefPrefix = "yaac-image:"
)

// Objects whose `data` is shell output the pane renders as text, so never
// stored apart even when it is a bare base64 image.
var textDataKeys = map[string]bool{"terminal_output": true, "terminal_output_delta": true}

// Whether `b` starts like a PNG, JPEG, GIF or WebP; the server serves only
// those (`sniffImage` in @yaac/shared/attachments).
func isImage(b []byte) bool {
	at := func(i int, text string) bool {
		return len(b) >= i+len(text) && string(b[i:i+len(text)]) == text
	}
	return (len(b) > 0 && b[0] == 0x89 && at(1, "PNG")) ||
		at(0, "\xff\xd8\xff") ||
		at(0, "GIF8") ||
		(at(0, "RIFF") && at(8, "WEBP"))
}

// Whole lines as the record keeps them, images stored apart under `dir`.
func withoutImages(buf []byte, dir string, log func(string)) []byte {
	if len(buf) < imageLineBytes {
		return buf
	}
	lines := bytes.Split(buf, []byte{'\n'})
	changed := false
	for i, line := range lines {
		if len(line) < imageLineBytes {
			continue
		}
		out, err := storeImagesInLine(line, dir)
		if err != nil {
			log(fmt.Sprintf("image not stored apart (%v)", err))
			continue
		}
		if out != nil {
			lines[i] = out
			changed = true
		}
	}
	if !changed {
		return buf
	}
	return bytes.Join(lines, []byte{'\n'})
}

type splice struct {
	start, end int
	hash       string
}

// The line with each image string replaced by its ref, or nil if it is not
// JSON or holds none. Strings are found by the decoder's offsets and spliced
// out, so every other byte stays as the agent wrote it.
func storeImagesInLine(line []byte, dir string) ([]byte, error) {
	if !json.Valid(line) {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var splices []splice

	var walk func(key string) error
	walk = func(key string) error {
		before := int(dec.InputOffset())
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case json.Delim:
			for dec.More() {
				k := ""
				if t == '{' {
					kt, err := dec.Token()
					if err != nil {
						return err
					}
					k = kt.(string)
					if textDataKeys[k] {
						var skip json.RawMessage
						if err := dec.Decode(&skip); err != nil {
							return err
						}
						continue
					}
				}
				if err := walk(k); err != nil {
					return err
				}
			}
			_, err = dec.Token()
			return err
		case string:
			if (key != "data" && key != "base64") || len(t) < imageDataChars {
				return nil
			}
			hash, err := storeImage(t, dir)
			if err != nil || hash == "" {
				return err
			}
			end := int(dec.InputOffset())
			start := before + bytes.IndexByte(line[before:end], '"')
			splices = append(splices, splice{start, end, hash})
		}
		return nil
	}
	if err := walk(""); err != nil {
		return nil, err
	}
	if len(splices) == 0 {
		return nil, nil
	}
	var out bytes.Buffer
	last := 0
	for _, s := range splices {
		out.Write(line[last:s.start])
		fmt.Fprintf(&out, `"%s%s"`, imageRefPrefix, s.hash)
		last = s.end
	}
	out.Write(line[last:])
	return out.Bytes(), nil
}

// Store one base64 image under its hash, written whole and durably named
// (the dir synced after the rename) before the record names it, so not even
// a power loss leaves the record pointing at a missing file. Returns "" if
// the data is not an image.
func storeImage(b64, dir string) (string, error) {
	head, err := base64.StdEncoding.DecodeString(b64[:16])
	if err != nil || !isImage(head) {
		return "", nil
	}
	// Padding is optional, as it is to the server's decoder.
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		if data, err = base64.RawStdEncoding.DecodeString(b64); err != nil {
			return "", nil
		}
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	imagesDir := filepath.Join(dir, "images")
	file := filepath.Join(imagesDir, hash)
	if _, err := os.Stat(file); err == nil {
		return hash, nil
	}
	if err := os.MkdirAll(imagesDir, 0o777); err != nil {
		return "", err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := writeSynced(tmp, data); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, file); err != nil {
		os.Remove(tmp)
		return "", err
	}
	d, err := os.Open(imagesDir)
	if err != nil {
		return "", err
	}
	defer d.Close()
	return hash, d.Sync()
}

func writeSynced(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = fdatasync(f)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
