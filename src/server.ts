import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

const dev = process.env.COZE_PROJECT_ENV !== 'PROD';
const hostname = process.env.HOSTNAME || 'localhost';
const port = Number(process.env.DEPLOY_RUN_PORT || 5001);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ─── WS 路由注册 ────
const wssMap = new Map<string, WebSocketServer>();

function registerWsEndpoint(path: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wssMap.set(path, wss);
  return wss;
}

function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const { pathname } = new URL(req.url!, `http://${req.headers.host}`);
  const wss = wssMap.get(pathname);
  if (wss) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (!dev) {
    socket.destroy();
  }
}

async function main() {
  await app.prepare();

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  server.once('error', (err) => {
    console.error(err);
    process.exit(1);
  });

  server.on('upgrade', handleUpgrade);

  // 注册 Slave WS 端点
  const slaveModule = await import('./ws-handlers/slave');
  slaveModule.setupSlaveHandler(registerWsEndpoint('/ws/slave'));

  server.listen(port, () => {
    console.log(
      `> Server listening at http://${hostname}:${port} as ${dev ? 'development' : process.env.COZE_PROJECT_ENV}`,
    );
  });
}

main();
