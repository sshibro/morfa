import {lookup} from 'node:dns/promises';
import https from 'node:https';
import {isIP} from 'node:net';
import {fail} from './errors';

/* One HTTPS exchange with a public host, as the shop's client (server/launch/billing.ts) makes it. Only `publicAddress` and
 * `safeHTTPS` exist here; `isPublicIp` is the public-address check, kept in this module so it needs nothing else. */

/** Whether an address is a public unicast one: never loopback, private, link-local, CGNAT, benchmark, multicast or special IPv6 space. */
export function isPublicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    const [first, second] = ipv6Hextets(ip);
    // Only 2xxx, the global unicast space in use. 6to4 (2002::/16) carries an IPv4 address inside it, which can be a private one;
    // 2001::/23 holds Teredo and the other special-purpose ranges; 2001:db8::/32 is documentation.
    return (
      (first & 0xf000) === 0x2000 &&
      first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
  }
  return false;
}
/** The eight 16-bit groups of a valid IPv6 text (compressed `::`, a trailing dotted IPv4 and a zone id included). */
function ipv6Hextets(ip: string): number[] {
  let text = ip.split('%')[0].toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const gap = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...gap, ...right].map(group => parseInt(group, 16));
}

export async function publicAddress(host: string) {
  const all = await lookup(host, {all: true});
  if (!all.length || all.some(x => !isPublicIp(x.address)))
    fail(400, 'unsafe_destination', 'Only public server addresses are allowed.');
  return all[0];
}
export async function safeHTTPS(raw: string, method = 'GET', body?: string, headers: Record<string, string> = {}) {
  const url = httpsURL(raw);
  const address = await publicAddress(url.hostname);
  return new Promise<{
    status: number;
    body: string;
    certificateExpires: string | null;
  }>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers,
        timeout: 15000,
        lookup: ((_h: any, opts: any, cb: any) =>
          opts.all ? cb(null, [address]) : cb(null, address.address, address.family)) as any,
      },
      res => {
        // Node can detach the socket before `end` on a keep-alive response.
        const certificateExpires = (res.socket as any)?.getPeerCertificate?.()?.valid_to || null;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) res.destroy(new Error('Response too large'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
            certificateExpires,
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsURL(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    fail(400, 'unsafe_destination', 'A public HTTPS address is needed.');
  return url;
}
