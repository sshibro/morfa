import net from 'node:net';

// A fake SMTP server for the tests: no letter leaves the machine (the same sink as tests/postgresql-runtime-design-team-email-invites.test.ts).
/** A minimal SMTP server that accepts every letter and keeps it (no TLS, no auth: what nodemailer speaks to on loopback). */
export async function smtpSink() {
  const letters: {from: string; to: string[]; data: string}[] = [];
  const server = net.createServer(socket => {
    let buffer = '',
      reading = false,
      letter = {from: '', to: [] as string[], data: ''};
    const reply = (line: string) => socket.write(line + '\r\n');
    reply('220 sink ESMTP');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (reading) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          letter.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          reading = false;
          letters.push(letter);
          letter = {from: '', to: [], data: ''};
          reply('250 queued');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') reply('250 sink');
        else if (verb === 'MAIL') (letter.from = line), reply('250 ok');
        else if (verb === 'RCPT') letter.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''), reply('250 ok');
        else if (verb === 'DATA') (reading = true), reply('354 go on');
        else if (verb === 'QUIT') reply('221 bye'), socket.end();
        else reply('250 ok');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {letters, port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>(resolve => server.close(() => resolve()))};
}
