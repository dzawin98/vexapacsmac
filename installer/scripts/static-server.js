const http = require('http');
const fs = require('fs');
const path = require('path');

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root || process.cwd());
const port = Number(args.port || process.env.PORT || 8080);
const spa = args.spa !== 'false';
const apiTarget = String(args.apiTarget || process.env.STATIC_API_TARGET || '').replace(/\/+$/, '');
const backupApiTarget = String(args.backupApiTarget || process.env.STATIC_BACKUP_API_TARGET || '').replace(/\/+$/, '');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  try {
    if (backupApiTarget && /^\/api\/system\/(?:backup|restore)(?:\/|\?|$)/.test(req.url || '')) {
      proxy(req, res, backupApiTarget);
      return;
    }

    if (apiTarget && (req.url || '').startsWith('/api/')) {
      proxy(req, res, apiTarget);
      return;
    }

    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const safePath = path.normalize(decodeURIComponent(requestUrl.pathname)).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(root, safePath === '/' ? 'index.html' : safePath);
    if (!filePath.startsWith(root)) {
      send(res, 400, 'Invalid path');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (!spa) {
        send(res, 404, 'Not found');
        return;
      }
      filePath = path.join(root, 'index.html');
    }
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
  } catch (error) {
    send(res, 500, error.message || 'Internal server error');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Static server listening on http://0.0.0.0:${port}`);
  console.log(`Serving ${root}`);
  if (apiTarget) {
    console.log(`Proxying /api to ${apiTarget}`);
  }
  if (backupApiTarget) {
    console.log(`Proxying /api/system/backup and /api/system/restore to ${backupApiTarget}`);
  }
});

function send(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true';
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function proxy(req, res, target) {
  const targetUrl = new URL(req.url || '/', target);
  const client = targetUrl.protocol === 'https:' ? require('https') : require('http');
  const proxyReq = client.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (error) => {
    send(res, 502, error.message || 'Bad gateway');
  });
  req.pipe(proxyReq);
}
