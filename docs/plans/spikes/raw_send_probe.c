// Raw-IP-socket bypass probe for the in-sandbox netstack DNAT spike.
// Runs INSIDE a gVisor sandbox that has CAP_NET_RAW (net-raw session class).
// It hand-crafts a TCP SYN to the ORIGINAL (pre-DNAT) destination and emits it
// on a SOCK_RAW/IPPROTO_RAW socket (implicit IP_HDRINCL — the app supplies the
// full IP header). The question the spike must answer: does that write traverse
// netstack's OUTPUT `nat` hook (so it gets DNAT'd to the proxy like an ordinary
// connect), or does it skip the hook and leave eth0 still addressed to the
// original dst? If the latter, a net-raw workload can exfiltrate past the
// interception point and the DNAT design does not hold for that session class.
// Usage: raw_send_probe <origdst-ip> [dport]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

// Minimal IP + TCP headers (avoid pulling netinet/ip.h struct bitfield ABI).
struct iphdr_min {
  unsigned char ihl_ver;   // version(4)<<4 | ihl(5)
  unsigned char tos;
  unsigned short tot_len;
  unsigned short id;
  unsigned short frag_off;
  unsigned char ttl;
  unsigned char protocol;
  unsigned short check;
  unsigned int saddr;
  unsigned int daddr;
};
struct tcphdr_min {
  unsigned short source, dest;
  unsigned int seq, ack_seq;
  unsigned char doff_res;  // data offset(5)<<4
  unsigned char flags;     // SYN=0x02
  unsigned short window, check, urg_ptr;
};

static unsigned short csum(unsigned short *b, int len) {
  unsigned long s = 0;
  while (len > 1) { s += *b++; len -= 2; }
  if (len == 1) s += *(unsigned char *)b;
  s = (s >> 16) + (s & 0xffff);
  s += (s >> 16);
  return (unsigned short)(~s);
}

int main(int argc, char **argv) {
  const char *dst = argc > 1 ? argv[1] : "203.0.113.7";
  int dport = argc > 2 ? atoi(argv[2]) : 443;

  int s = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
  if (s < 0) { printf("RAW socket() rc=-1 errno=%d (%s)\n", errno, strerror(errno)); fflush(stdout); return 3; }
  int on = 1;
  setsockopt(s, IPPROTO_IP, IP_HDRINCL, &on, sizeof on);

  char pkt[sizeof(struct iphdr_min) + sizeof(struct tcphdr_min)];
  memset(pkt, 0, sizeof pkt);
  struct iphdr_min *ip = (void *)pkt;
  struct tcphdr_min *tcp = (void *)(pkt + sizeof *ip);

  ip->ihl_ver = (4 << 4) | 5;
  ip->tot_len = htons(sizeof pkt);
  ip->id = htons(0x4242);
  ip->ttl = 64;
  ip->protocol = IPPROTO_TCP;
  ip->saddr = inet_addr("10.98.0.2");   // the sandbox pod IP
  ip->daddr = inet_addr(dst);
  ip->check = csum((unsigned short *)ip, sizeof *ip);

  tcp->source = htons(44444);
  tcp->dest = htons(dport);
  tcp->seq = htonl(0x11223344);
  tcp->doff_res = (5 << 4);
  tcp->flags = 0x02;  // SYN
  tcp->window = htons(65535);

  struct sockaddr_in to; memset(&to, 0, sizeof to);
  to.sin_family = AF_INET;
  to.sin_port = htons(dport);
  to.sin_addr.s_addr = inet_addr(dst);

  int r = sendto(s, pkt, sizeof pkt, 0, (struct sockaddr *)&to, sizeof to);
  printf("RAW sendto(%s:%d) rc=%d errno=%d (%s)\n",
         dst, dport, r, r < 0 ? errno : 0, r < 0 ? strerror(errno) : "sent");
  fflush(stdout);

  // Control: same raw socket to an ON-LINK dst (10.98.0.123:443). If this one
  // egresses but the external one didn't, netstack's raw path just couldn't
  // route the external dst (no bypass); the on-link result also shows whether
  // DNAT rewrote it (arrives at proxy) or not (arrives at 10.98.0.123).
  ip->daddr = inet_addr("10.98.0.123");
  ip->check = 0; ip->check = csum((unsigned short *)ip, sizeof *ip);
  to.sin_addr.s_addr = inet_addr("10.98.0.123");
  int r2 = sendto(s, pkt, sizeof pkt, 0, (struct sockaddr *)&to, sizeof to);
  printf("RAW sendto(10.98.0.123:%d on-link) rc=%d errno=%d (%s)\n",
         dport, r2, r2 < 0 ? errno : 0, r2 < 0 ? strerror(errno) : "sent");
  fflush(stdout);
  return r < 0 ? 1 : 0;
}
