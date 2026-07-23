// AF_PACKET L2-injection bypass probe for the in-sandbox netstack DNAT spike.
// Runs INSIDE a gVisor sandbox whose handler enables `allow-packet-socket-write`
// (yaac's gvisor-nested class does exactly this). It builds a TCP SYN to the
// ORIGINAL (pre-DNAT) destination and injects it straight onto eth0 via an
// AF_PACKET SOCK_DGRAM socket — i.e. at layer 2, below netstack's IP OUTPUT
// path. If the peer sees a frame addressed to the original dst, the packet
// socket bypassed the netstack `nat` OUTPUT hook and the DNAT interception does
// not contain this session class. Broadcast dst MAC so the peer's raw
// PREROUTING counter sees it regardless of ARP.
// Usage: pkt_send_probe <origdst-ip> [dport]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <arpa/inet.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <linux/sockios.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>

struct iphdr_min {
  unsigned char ihl_ver, tos; unsigned short tot_len, id, frag_off;
  unsigned char ttl, protocol; unsigned short check;
  unsigned int saddr, daddr;
};
struct tcphdr_min {
  unsigned short source, dest; unsigned int seq, ack_seq;
  unsigned char doff_res, flags; unsigned short window, check, urg_ptr;
};
static unsigned short csum(unsigned short *b, int len) {
  unsigned long s = 0; while (len > 1) { s += *b++; len -= 2; }
  if (len == 1) s += *(unsigned char *)b;
  s = (s >> 16) + (s & 0xffff); s += (s >> 16);
  return (unsigned short)(~s);
}

int main(int argc, char **argv) {
  const char *dst = argc > 1 ? argv[1] : "203.0.113.7";
  int dport = argc > 2 ? atoi(argv[2]) : 443;

  int s = socket(AF_PACKET, SOCK_DGRAM, htons(ETH_P_IP));
  if (s < 0) { printf("PKT socket() rc=-1 errno=%d (%s)\n", errno, strerror(errno)); fflush(stdout); return 3; }

  // netstack doesn't expose eth0's index via netlink/ioctl (both return 0), so
  // brute-force candidate NIC indexes 1..4. Each index gets a DISTINCT dst
  // (base .7 + ifindex) so the peer's per-dst counter reveals which index — if
  // any — actually put a frame on the wire addressed to the original dst
  // (= an L2 bypass of the netstack IP OUTPUT hook).
  (void)dst;
  // Name each candidate index so we know whether index 1 is eth0 or lo.
  for (int i = 1; i <= 4; i++) {
    struct ifreq nr; memset(&nr, 0, sizeof nr); nr.ifr_ifindex = i;
    if (ioctl(s, SIOCGIFNAME, &nr) == 0)
      printf("PKT ifindex=%d name=%s\n", i, nr.ifr_name);
    else
      printf("PKT ifindex=%d name=? errno=%d (%s)\n", i, errno, strerror(errno));
    fflush(stdout);
  }
  int base3 = 7;  // 203.0.113.(7+ifindex)
  for (int ifidx = 1; ifidx <= 4; ifidx++) {
    char dbuf[32]; snprintf(dbuf, sizeof dbuf, "203.0.113.%d", base3 + ifidx);
    char pkt[sizeof(struct iphdr_min) + sizeof(struct tcphdr_min)];
    memset(pkt, 0, sizeof pkt);
    struct iphdr_min *ip = (void *)pkt;
    struct tcphdr_min *tcp = (void *)(pkt + sizeof *ip);
    ip->ihl_ver = (4 << 4) | 5; ip->tot_len = htons(sizeof pkt);
    ip->id = htons(0x4343); ip->ttl = 64; ip->protocol = IPPROTO_TCP;
    ip->saddr = inet_addr("10.98.0.2"); ip->daddr = inet_addr(dbuf);
    ip->check = csum((unsigned short *)ip, sizeof *ip);
    tcp->source = htons(55555); tcp->dest = htons(dport);
    tcp->seq = htonl(0x55667788); tcp->doff_res = (5 << 4);
    tcp->flags = 0x02; tcp->window = htons(65535);

    struct sockaddr_ll sll; memset(&sll, 0, sizeof sll);
    sll.sll_family = AF_PACKET;
    sll.sll_protocol = htons(ETH_P_IP);
    sll.sll_ifindex = ifidx;
    sll.sll_halen = 6;
    memset(sll.sll_addr, 0xff, 6);  // broadcast dst MAC

    int r = sendto(s, pkt, sizeof pkt, 0, (struct sockaddr *)&sll, sizeof sll);
    printf("PKT ifindex=%d dst=%s:%d sendto rc=%d errno=%d (%s)\n",
           ifidx, dbuf, dport, r, r < 0 ? errno : 0, r < 0 ? strerror(errno) : "sent");
    fflush(stdout);
  }
  return 0;
}
