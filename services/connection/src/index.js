import http from 'http';
import jwt from 'jsonwebtoken';
import amqplib from 'amqplib';
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';

const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const EXCHANGE_NAME = process.env.EXCHANGE_NAME || 'chat.messages';
const REDIS_URL = process.env.REDIS_URL;

if (!RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');
if (!REDIS_URL) throw new Error('REDIS_URL is required');

const redis = createClient({ url: REDIS_URL });
redis.on('error', (e) => console.error('redis error', e));

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

// roomId -> Set(ws)
const roomSockets = new Map();

function addToRoom(roomId, ws) {
  if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
  roomSockets.get(roomId).add(ws);
  ws.rooms.add(roomId);
}

function removeWs(ws) {
  for (const roomId of ws.rooms) {
    const set = roomSockets.get(roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) roomSockets.delete(roomId);
    }
  }
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function broadcast(roomId, obj) {
  const set = roomSockets.get(roomId);
  if (!set) return;
  const payload = JSON.stringify(obj);
  for (const ws of set) {
    try { ws.send(payload); } catch { /* ignore */ }
  }
}

async function setPresence(user, status) {
  try {
    const key = `presence:${user.id}`;
    await redis.set(key, JSON.stringify({ status, username: user.username }), { EX: 40 });
  } catch {
    // best-effort
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // Redis
  {
    let lastErr;
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        await redis.connect();
        break;
      } catch (e) {
        lastErr = e;
        console.error(`redis connect failed (attempt ${attempt}/30)`);
        await sleep(1000);
      }
    }
    if (!redis.isOpen) throw lastErr;
  }

  // AMQP consumer (fan-out)
  let conn;
  let ch;
  {
    let lastErr;
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        conn = await amqplib.connect(RABBITMQ_URL);
        ch = await conn.createChannel();
        await ch.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
        break;
      } catch (e) {
        lastErr = e;
        console.error(`amqp connect failed (attempt ${attempt}/30)`);
        await sleep(1000);
      }
    }
    if (!ch) throw lastErr;
  }

  // One queue per instance to scale-out
  const q = await ch.assertQueue('', { exclusive: true, autoDelete: true });
  await ch.bindQueue(q.queue, EXCHANGE_NAME, 'room.*');

  ch.consume(q.queue, (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString('utf-8'));
      if (payload?.type === 'message' && payload.roomId) {
        broadcast(payload.roomId, payload);
      }
      ch.ack(msg);
    } catch (e) {
      console.error('consume error', e);
      ch.nack(msg, false, false);
    }
  });

  wss.on('connection', (ws) => {
    ws.isAuthed = false;
    ws.user = null;
    ws.rooms = new Set();

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'auth') {
        try {
          const payload = jwt.verify(msg.token, JWT_SECRET);
          ws.user = { id: payload.sub, username: payload.username };
          ws.isAuthed = true;
          await setPresence(ws.user, 'online');
          send(ws, { type: 'ready' });
          return;
        } catch {
          send(ws, { type: 'error', message: 'Not authorized' });
          ws.close();
          return;
        }
      }

      if (!ws.isAuthed) {
        send(ws, { type: 'error', message: 'Auth required' });
        return;
      }

      if (msg.type === 'join' && msg.roomId) {
        addToRoom(msg.roomId, ws);
        send(ws, { type: 'joined', roomId: msg.roomId });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }
    });

    ws.on('close', async () => {
      removeWs(ws);
      if (ws.user) {
        await setPresence(ws.user, 'offline');
      }
    });
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  server.listen(PORT, () => {
    console.log(`connection listening on ${PORT}`);
  });
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
