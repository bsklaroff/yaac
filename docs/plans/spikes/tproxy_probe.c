// TPROXY interception probe — the minimal core of the per-pod forwarder
// from stock-k8s-multi-node.md §4. Binds an IP_TRANSPARENT listener, and on
// each accepted connection recovers the ORIGINAL destination (getsockname on a
// TPROXY socket returns the pre-redirect dst) and the client source. Proves:
//  (1) host-kernel TPROXY in the veth-peer netns intercepts the pod's egress,
//  (2) the forwarder recovers dst host:port (what yaac-proxy needs to route),
//  (3) identity is the arrival netns/iface, independent of the (spoofable) src.
// Usage: tproxy_probe <listen_port> [max_accepts]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s port [max]\n", argv[0]); return 2; }
  int port = atoi(argv[1]);
  int max = argc > 2 ? atoi(argv[2]) : 1;

  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) { perror("socket"); return 1; }
  int on = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
  // IP_TRANSPARENT (val 19) — required for a socket to receive TPROXY'd
  // packets whose dst IP is not local.
  if (setsockopt(s, IPPROTO_IP, 19 /*IP_TRANSPARENT*/, &on, sizeof on) < 0) {
    perror("IP_TRANSPARENT"); return 1;
  }
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_addr.s_addr = INADDR_ANY; a.sin_port = htons(port);
  if (bind(s, (struct sockaddr*)&a, sizeof a) < 0) { perror("bind"); return 1; }
  if (listen(s, 16) < 0) { perror("listen"); return 1; }
  printf("LISTENING transparent on :%d\n", port); fflush(stdout);

  for (int i = 0; i < max; i++) {
    struct sockaddr_in cli; socklen_t cl = sizeof cli;
    int c = accept(s, (struct sockaddr*)&cli, &cl);
    if (c < 0) { perror("accept"); return 1; }
    struct sockaddr_in orig; socklen_t ol = sizeof orig;
    // On a TPROXY-delivered socket, getsockname == original destination.
    getsockname(c, (struct sockaddr*)&orig, &ol);
    char cbuf[64], obuf[64];
    inet_ntop(AF_INET, &cli.sin_addr, cbuf, sizeof cbuf);
    inet_ntop(AF_INET, &orig.sin_addr, obuf, sizeof obuf);
    printf("INTERCEPTED src=%s:%d -> origdst=%s:%d\n",
           cbuf, ntohs(cli.sin_port), obuf, ntohs(orig.sin_port));
    fflush(stdout);
    close(c);
  }
  close(s);
  return 0;
}
