package main

// mountd's view of the pods on its node, through client-go with its service
// account. An informer on the node's pods wakes release whenever one
// changes, but release acts on a fresh list: an informer that fell behind
// (a watch that broke and has not relisted yet) could miss a new pod and
// make its directory look unowned, and a list that fails releases nothing.

import (
	"context"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
)

// nodePods reads the pods of one namespace on one node.
type nodePods struct {
	client    kubernetes.Interface
	namespace string
	node      string
	// changed is signalled, without blocking, on every change the informer
	// sees.
	changed chan struct{}
}

func newNodePods(namespace, node string) (*nodePods, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, err
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &nodePods{client: client, namespace: namespace, node: node, changed: make(chan struct{}, 1)}, nil
}

func (n *nodePods) selector() string {
	return fields.OneTermEqualSelector("spec.nodeName", n.node).String()
}

// get reads one pod fresh.
func (n *nodePods) get(ctx context.Context, name string) (*corev1.Pod, error) {
	return n.client.CoreV1().Pods(n.namespace).Get(ctx, name, metav1.GetOptions{})
}

// list reads the node's pods fresh.
func (n *nodePods) list(ctx context.Context) ([]corev1.Pod, error) {
	l, err := n.client.CoreV1().Pods(n.namespace).List(ctx, metav1.ListOptions{FieldSelector: n.selector()})
	if err != nil {
		return nil, err
	}
	return l.Items, nil
}

// watch starts an informer on the node's pods that signals changed.
func (n *nodePods) watch(ctx context.Context) error {
	f := informers.NewSharedInformerFactoryWithOptions(n.client, 0,
		informers.WithNamespace(n.namespace),
		informers.WithTweakListOptions(func(o *metav1.ListOptions) { o.FieldSelector = n.selector() }))
	signal := func(any) {
		select {
		case n.changed <- struct{}{}:
		default:
		}
	}
	if _, err := f.Core().V1().Pods().Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    signal,
		UpdateFunc: func(_, obj any) { signal(obj) },
		DeleteFunc: signal,
	}); err != nil {
		return err
	}
	f.Start(ctx.Done())
	return nil
}

// runningContainer is the id of the named container if it runs.
func runningContainer(p *corev1.Pod, name string) (string, bool) {
	for _, s := range append(append([]corev1.ContainerStatus(nil), p.Status.ContainerStatuses...), p.Status.InitContainerStatuses...) {
		if s.Name == name && s.State.Running != nil {
			_, id, ok := strings.Cut(s.ContainerID, "://")
			return id, ok && id != ""
		}
	}
	return "", false
}

// hostPathUnder names the pod's hostPath volume directly inside root, if
// it has one.
func hostPathUnder(p *corev1.Pod, root string) (string, bool) {
	for _, v := range p.Spec.Volumes {
		if v.HostPath == nil {
			continue
		}
		rest, ok := strings.CutPrefix(v.HostPath.Path, root+"/")
		if ok && rest != "" && !strings.Contains(rest, "/") {
			return rest, true
		}
	}
	return "", false
}
