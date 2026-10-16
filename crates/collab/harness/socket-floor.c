// The socket floor of TARGETS M10 on this box: a server with no application logic that reads one small message per
// event and writes one frame per socket per flush, against a client process sending at the M10 rates.
//   floor server <port> <frame bytes> <flush hz>
//   floor client <port> <sockets> <msg bytes> <hz> <seconds>
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/timerfd.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>

#define MAXS 4096
static int nb(int fd) { return fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }

static int server(int port, int frame, int hz) {
  int ls = socket(AF_INET, SOCK_STREAM, 0), one = 1;
  setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  if (bind(ls, (void *)&a, sizeof a) || listen(ls, 4096)) { perror("listen"); return 1; }
  nb(ls);
  int ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN, .data.fd = ls};
  epoll_ctl(ep, EPOLL_CTL_ADD, ls, &ev);
  int tf = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK);
  if (hz > 0) {
    struct itimerspec it = {.it_interval = {0, 1000000000L / hz}, .it_value = {0, 1000000000L / hz}};
    timerfd_settime(tf, 0, &it, 0);
  }
  ev.data.fd = tf; epoll_ctl(ep, EPOLL_CTL_ADD, tf, &ev);
  int socks[MAXS], n = 0;
  char head[4] = {(char)0x81, 126, (char)(frame >> 8), (char)frame};
  char *body = malloc(frame); memset(body, 'x', frame);
  char buf[65536];
  struct epoll_event evs[256];
  for (;;) {
    int k = epoll_wait(ep, evs, 256, -1);
    for (int i = 0; i < k; i++) {
      int fd = evs[i].data.fd;
      if (fd == ls) {
        int c;
        while ((c = accept4(ls, 0, 0, SOCK_NONBLOCK)) >= 0) {
          setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
          socks[n++] = c;
          struct epoll_event e = {.events = EPOLLIN | EPOLLET, .data.fd = c};
          epoll_ctl(ep, EPOLL_CTL_ADD, c, &e);
        }
      } else if (fd == tf) {
        unsigned long long x; read(tf, &x, sizeof x);
        struct iovec v[2] = {{head, 4}, {body, frame}};
        for (int s = 0; s < n; s++) writev(socks[s], v, 2);
      } else {
        // One read per readiness, as the service's reader takes one message per wake.
        if (recv(fd, buf, sizeof buf, 0) == 0) close(fd);
      }
    }
  }
}

static int client(int port, int count, int msg, int hz, int secs) {
  int ep = epoll_create1(0), one = 1;
  int *socks = calloc(count, sizeof(int));
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  for (int i = 0; i < count; i++) {
    socks[i] = socket(AF_INET, SOCK_STREAM, 0);
    if (connect(socks[i], (void *)&a, sizeof a)) { perror("connect"); return 1; }
    setsockopt(socks[i], IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    nb(socks[i]);
    struct epoll_event e = {.events = EPOLLIN, .data.fd = socks[i]};
    epoll_ctl(ep, EPOLL_CTL_ADD, socks[i], &e);
  }
  int tf = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK);
  struct itimerspec it = {.it_interval = {0, 1000000}, .it_value = {0, 1000000}};
  timerfd_settime(tf, 0, &it, 0);
  struct epoll_event ev = {.events = EPOLLIN, .data.fd = tf};
  epoll_ctl(ep, EPOLL_CTL_ADD, tf, &ev);
  char *m = malloc(msg); memset(m, 'y', msg);
  char buf[65536];
  struct epoll_event evs[256];
  time_t end = time(0) + secs;
  long tick = 0;
  int per_ms = hz > 0 ? 1000 / hz : 0; // each socket sends once per period, spread over its ms slots
  while (time(0) < end) {
    int k = epoll_wait(ep, evs, 256, 100);
    for (int i = 0; i < k; i++) {
      int fd = evs[i].data.fd;
      if (fd == tf) {
        unsigned long long x; read(tf, &x, sizeof x);
        if (per_ms) for (unsigned long long t = 0; t < x; t++, tick++)
          for (int s = (int)(tick % per_ms); s < count; s += per_ms) send(socks[s], m, msg, 0);
      } else {
        while (recv(fd, buf, sizeof buf, 0) > 0) {}
      }
    }
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 4 && !strcmp(argv[1], "server")) return server(atoi(argv[2]), atoi(argv[3]), atoi(argv[4]));
  if (argc > 6 && !strcmp(argv[1], "client")) return client(atoi(argv[2]), atoi(argv[3]), atoi(argv[4]), atoi(argv[5]), atoi(argv[6]));
  fprintf(stderr, "usage\n"); return 2;
}
