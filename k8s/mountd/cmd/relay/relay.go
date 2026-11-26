package main

// The relay's three paths. Out: a sandbox's connection arrives on its
// egress.sock with netshim's header, and leaves for the proxy behind one
// naming the sandbox and carrying the proxy auth secret. In, streams: the
// server's dial names a workspace and authenticates with the same secret,
// and is spliced to that workspace's ingress.sock at streamd's port. In,
// sites: the router's header names a site, whose Service names the live
// release and its port.

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	listersv1 "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"

	"yaac-mountd/internal/pp2"
	"yaac-mountd/internal/sockets"
)

// Labels and names the server writes (packages/server/src/drivers/k8s).
const (
	labelWorkspaceID        = "yaac.workspace-id"
	labelBuildID            = "yaac.build-id"
	socketsVolume           = "sockets"
	siteServicePrefix       = "yaac-site-"
	annotationLiveWorkspace = "yaac.live-workspace-id"
)

// Deadlines and bounds, as the proxy's stream relay kept them.
const (
	headerTimeout     = 10 * time.Second
	streamAuthTimeout = 6 * time.Second
	streamLineMax     = 4 * 1024
	proxyDialTimeout  = 5 * time.Second
	keepAlive         = 60 * time.Second
	resyncInterval    = 30 * time.Second
)

var siteIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,100}$`)

type config struct {
	root         string
	nodeRoot     string
	proxy        string
	secret       string
	streamListen string
	siteListen   string
	streamPort   int
	readyFile    string
	dirMode      fs.FileMode
	namespace    string
	node         string
}

type relay struct {
	cfg      config
	client   kubernetes.Interface
	socks    *sockets.Server
	services listersv1.ServiceLister
	changed  chan struct{}

	mu sync.Mutex
	// dirs maps a unit's id to its directory, from the last list.
	dirs map[string]string

	streamLn, siteLn net.Listener
}

func newRelay(cfg config, client kubernetes.Interface) *relay {
	r := &relay{cfg: cfg, client: client, changed: make(chan struct{}, 1), dirs: map[string]string{}}
	r.socks = sockets.New(cfg.root, r.egress, sockets.Options{DirMode: cfg.dirMode})
	return r
}

// unitOf is the unit a pod is, if it is a sandbox of this install that is
// not done: its id from its label, and its directory from its `sockets`
// volume, accepted only directly beneath the install's socket root.
func (r *relay) unitOf(p *corev1.Pod) (sockets.Unit, bool) {
	if p.Spec.NodeName != r.cfg.node || p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
		return sockets.Unit{}, false
	}
	id := p.Labels[labelWorkspaceID]
	if id == "" {
		id = p.Labels[labelBuildID]
	}
	if id == "" {
		return sockets.Unit{}, false
	}
	for _, v := range p.Spec.Volumes {
		if v.Name != socketsVolume || v.HostPath == nil {
			continue
		}
		rest, ok := strings.CutPrefix(v.HostPath.Path, r.cfg.nodeRoot+"/")
		if ok && rest != "" && !strings.Contains(rest, "/") && rest != "." && rest != ".." {
			return sockets.Unit{Dir: rest, ID: id}, true
		}
	}
	return sockets.Unit{}, false
}

// list reads the node's pods fresh, never from the informer: an informer
// that fell behind could miss a new pod and have its directory removed.
// A unit's id maps to the pod that is not being deleted, when one is.
func (r *relay) list() ([]sockets.Unit, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	l, err := r.client.CoreV1().Pods(r.cfg.namespace).List(ctx, metav1.ListOptions{
		FieldSelector: fields.OneTermEqualSelector("spec.nodeName", r.cfg.node).String(),
	})
	if err != nil {
		return nil, err
	}
	var units []sockets.Unit
	dirs := map[string]string{}
	deleting := map[string]bool{}
	for i := range l.Items {
		p := &l.Items[i]
		u, ok := r.unitOf(p)
		if !ok {
			continue
		}
		units = append(units, u)
		if _, seen := dirs[u.ID]; !seen || (deleting[u.ID] && p.DeletionTimestamp == nil) {
			dirs[u.ID] = u.Dir
			deleting[u.ID] = p.DeletionTimestamp != nil
		}
	}
	r.mu.Lock()
	r.dirs = dirs
	r.mu.Unlock()
	return units, nil
}

func (r *relay) reconcile() {
	if err := r.socks.Reconcile(r.list); err != nil {
		log.Printf("relay: reconcile: %v", err)
	}
}

func (r *relay) dirOf(id string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dirs[id]
	return d, ok
}

// start watches the node's pods and the namespace's Services, binds the
// two listeners, binds every unit's socket once, and marks the relay
// ready. The loops it starts run until ctx ends.
func (r *relay) start(ctx context.Context) error {
	if fi, err := os.Stat(r.cfg.root); err != nil || !fi.IsDir() {
		return fmt.Errorf("socket root %s is not a directory: %v", r.cfg.root, err)
	}
	pods := informers.NewSharedInformerFactoryWithOptions(r.client, 0,
		informers.WithNamespace(r.cfg.namespace),
		informers.WithTweakListOptions(func(o *metav1.ListOptions) {
			o.FieldSelector = fields.OneTermEqualSelector("spec.nodeName", r.cfg.node).String()
		}))
	signal := func(any) {
		select {
		case r.changed <- struct{}{}:
		default:
		}
	}
	if _, err := pods.Core().V1().Pods().Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: signal, UpdateFunc: func(_, o any) { signal(o) }, DeleteFunc: signal,
	}); err != nil {
		return err
	}
	svcs := informers.NewSharedInformerFactoryWithOptions(r.client, 0, informers.WithNamespace(r.cfg.namespace))
	r.services = svcs.Core().V1().Services().Lister()
	pods.Start(ctx.Done())
	svcs.Start(ctx.Done())
	svcs.WaitForCacheSync(ctx.Done())

	lc := net.ListenConfig{KeepAlive: keepAlive}
	var err error
	if r.streamLn, err = lc.Listen(ctx, "tcp", r.cfg.streamListen); err != nil {
		return err
	}
	if r.siteLn, err = lc.Listen(ctx, "tcp", r.cfg.siteListen); err != nil {
		r.streamLn.Close()
		return err
	}
	go accept(r.streamLn, r.stream)
	go accept(r.siteLn, r.site)
	r.reconcile()
	go func() {
		t := time.NewTicker(resyncInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				r.streamLn.Close()
				r.siteLn.Close()
				r.socks.Close()
				return
			case <-r.changed:
			case <-t.C:
			}
			r.reconcile()
		}
	}()
	if r.cfg.readyFile != "" {
		if err := os.WriteFile(r.cfg.readyFile, nil, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func accept(ln net.Listener, handle func(net.Conn)) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("relay: accept: %v", err)
			continue
		}
		go handle(c)
	}
}

// egress carries one connection from a sandbox to the proxy. netshim's
// header gives the destination; any TLV it sent is dropped, and the id
// comes from the directory the connection arrived in.
func (r *relay) egress(id string, c net.Conn) {
	c.SetReadDeadline(time.Now().Add(headerTimeout))
	in, err := pp2.Read(c)
	if err != nil || !in.Src.Addr().Is4() || !in.Dst.Addr().Is4() {
		log.Printf("relay: bad header from %s: %v", id, err)
		c.Close()
		return
	}
	c.SetReadDeadline(time.Time{})
	out := pp2.Header{Src: in.Src, Dst: in.Dst, TLVs: []pp2.TLV{
		{Type: pp2.TLVID, Value: []byte(id)},
		{Type: pp2.TLVSecret, Value: []byte(r.cfg.secret)},
	}}
	head, err := out.Encode()
	if err != nil {
		c.Close()
		return
	}
	d := net.Dialer{Timeout: proxyDialTimeout, KeepAlive: keepAlive}
	p, err := d.Dial("tcp", r.cfg.proxy)
	if err != nil {
		log.Printf("relay: proxy dial for %s: %v", id, err)
		c.Close()
		return
	}
	if _, err := p.Write(head); err != nil {
		c.Close()
		p.Close()
		return
	}
	sockets.Splice(c, p)
}

// stream serves the server's dial into a workspace's streamd. Its first
// line is `{token, workspaceId}`. A bad line closes silently; every other
// refusal answers `{ok:false}`, since the server reads a silent close as a
// dead peer.
func (r *relay) stream(c net.Conn) {
	c.SetReadDeadline(time.Now().Add(streamAuthTimeout))
	br := bufio.NewReaderSize(c, streamLineMax)
	line, err := br.ReadSlice('\n')
	if err != nil {
		c.Close()
		return
	}
	var auth map[string]any
	if json.Unmarshal(line, &auth) != nil {
		c.Close()
		return
	}
	token, _ := auth["token"].(string)
	id, ok := auth["workspaceId"].(string)
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(r.cfg.secret)) != 1 {
		log.Printf("relay: refused a stream dial: bad auth line")
		c.Close()
		return
	}
	dir, ok := r.dirOf(id)
	if !ok {
		refuse(c, "unknown workspace")
		return
	}
	u, err := r.socks.DialIngress(dir)
	if err != nil {
		refuse(c, "ingress dial failed: "+err.Error())
		return
	}
	c.SetReadDeadline(time.Time{})
	pre := binary.BigEndian.AppendUint16(nil, uint16(r.cfg.streamPort))
	if n := br.Buffered(); n > 0 {
		b, _ := br.Peek(n)
		pre = append(pre, b...)
	}
	if _, err := u.Write(pre); err != nil {
		refuse(c, "ingress write failed: "+err.Error())
		u.Close()
		return
	}
	sockets.Splice(c, u)
}

func refuse(c net.Conn, reason string) {
	b, _ := json.Marshal(map[string]any{"ok": false, "error": "relay: " + reason})
	c.Write(append(b, '\n'))
	c.Close()
}

// site serves the router's connection to a site. The header's id TLV
// names the site, and its Service the live release's workspace and port;
// a site with no live release on this node gets a close.
func (r *relay) site(c net.Conn) {
	c.SetReadDeadline(time.Now().Add(headerTimeout))
	h, err := pp2.Read(c)
	if err != nil {
		c.Close()
		return
	}
	c.SetReadDeadline(time.Time{})
	id, _ := h.TLV(pp2.TLVID)
	if !siteIDPattern.Match(id) {
		c.Close()
		return
	}
	svc, err := r.services.Services(r.cfg.namespace).Get(siteServicePrefix + string(id))
	if err != nil || len(svc.Spec.Ports) == 0 {
		c.Close()
		return
	}
	port := svc.Spec.Ports[0].TargetPort.IntValue()
	dir, ok := r.dirOf(svc.Annotations[annotationLiveWorkspace])
	if port <= 0 || port > 0xffff || !ok {
		c.Close()
		return
	}
	u, err := r.socks.DialIngress(dir)
	if err != nil {
		log.Printf("relay: site %s: %v", id, err)
		c.Close()
		return
	}
	if _, err := u.Write(binary.BigEndian.AppendUint16(nil, uint16(port))); err != nil {
		c.Close()
		u.Close()
		return
	}
	sockets.Splice(c, u)
}
