import http from 'node:http';

// The balancer of a two-process e2e run (E2E_API_PROCESSES=2, scripts/e2e-server.ts), as Caddy is in production
// (deploy/caddy/morfa-routes.caddy: `lb_policy least_conn`): every request on its own goes to the api process with fewer
// requests open, so a file's event stream lives on one process and the posts beside it land on either. `pinned` paths
// (the run's own /__e2e routes) always reach the first process; `after` runs once such a request is answered, before the
// browser hears the answer (the switches it flipped are copied to the second process by then).

export type Balancer = {server: http.Server; close(): Promise<void>};

export function startBalancer(options: {port: number; targets: number[]; pinned: (path: string) => boolean; after: () => Promise<void>}): Promise<Balancer> {
  const open = options.targets.map(() => 0);
  let turn = 0;
  const pick = () => {
    const least = Math.min(...open);
    const tied = open.flatMap((count, index) => (count === least ? [index] : []));
    return tied[turn++ % tied.length];
  };
  const server = http.createServer((req, res) => {
    const pinned = options.pinned(req.url ?? '/');
    const index = pinned ? 0 : pick();
    open[index]++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      open[index]--;
    };
    res.once('close', finish);
    const upstream = http.request({host: '127.0.0.1', port: options.targets[index], method: req.method, path: req.url, headers: req.headers}, answer => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      // An event stream: every chunk at once.
      res.flushHeaders();
      if (!pinned) {
        answer.pipe(res);
        return;
      }
      answer.pipe(res, {end: false});
      answer.once('end', () => void options.after().then(() => res.end(), () => res.destroy()));
    });
    upstream.once('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    // The browser went away (a closed stream, a reload): so does the request upstream, as Caddy closes it.
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () =>
      resolve({
        server,
        close: () =>
          new Promise<void>(done => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}
