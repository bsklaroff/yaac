// Minimal workload run INSIDE a gVisor sandbox: connect() to a hardcoded
// dst and report. Used to prove the sentry's fdbased AF_PACKET egress is
// caught by peer-side TPROXY. Static so the sandbox rootfs needs no libs.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
int main(int argc, char **argv) {
  const char *ip = argc > 1 ? argv[1] : "203.0.113.7";
  int port = argc > 2 ? atoi(argv[2]) : 443;
  int s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_port = htons(port);
  inet_pton(AF_INET, ip, &a.sin_addr);
  printf("SANDBOX connecting to %s:%d\n", ip, port); fflush(stdout);
  int r = connect(s, (struct sockaddr*)&a, sizeof a);
  printf("SANDBOX connect() rc=%d (%s)\n", r, r==0?"ESTABLISHED":"failed");
  fflush(stdout);
  if (r == 0) { char b[16]; write(s, "hi\n", 3); read(s, b, sizeof b); }
  return r == 0 ? 0 : 1;
}
