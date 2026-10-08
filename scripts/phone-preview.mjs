import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/device-mode.js', ['device-mode.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/mySketch2.js', ['mySketch2.js', 'text/javascript']]
]);
const server = http.createServer(async (req, res) => {
  const file = files.get(new URL(req.url, 'http://localhost').pathname);
  if (!file || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const content = await readFile(new URL(file[0], root));
    res.writeHead(200, {
      'Content-Type': `${file[1]}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(self), microphone=()',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(500).end('Unable to load app');
  }
});
let tunnel;
function stop() {
  tunnel?.kill('SIGTERM');
  server.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`Footage local preview: ${url}`);
  console.log('Open the https://…trycloudflare.com link below on your phone. Keep this process running.');
  const binary = process.env.CLOUDFLARED_PATH || fileURLToPath(new URL('.tools/cloudflared', root));
  tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--url', url], { stdio: 'inherit' });
  tunnel.on('error', error => {
    console.error(`Cannot start cloudflared: ${error.message}. See README.md.`);
    process.exitCode = 1;
    server.close();
  });
  tunnel.on('exit', code => { server.close(); process.exitCode = code || 0; });
});
