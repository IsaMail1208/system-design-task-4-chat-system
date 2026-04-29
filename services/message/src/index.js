import express from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import amqplib from 'amqplib';

const { Pool } = pg;

const PORT = process.env.PORT || 3002;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const EXCHANGE_NAME = process.env.EXCHANGE_NAME || 'chat.messages';

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');

const pool = new Pool({ connectionString: DATABASE_URL });

let amqpConn;
let amqpCh;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initAmqp() {
  let lastErr;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      amqpConn = await amqplib.connect(RABBITMQ_URL);
      amqpCh = await amqpConn.createChannel();
      await amqpCh.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
      return;
    } catch (e) {
      lastErr = e;
      // eslint-disable-next-line no-console
      console.error(`amqp connect failed (attempt ${attempt}/30)`);
      await sleep(1000);
    }
  }
  throw lastErr;
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return res.status(401).json({ message: 'missing bearer token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, username: payload.username };
    return next();
  } catch {
    return res.status(401).json({ message: 'invalid token' });
  }
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/rooms', authMiddleware, async (_req, res) => {
  const r = await pool.query('SELECT id, name FROM rooms ORDER BY created_at ASC');
  return res.json({ items: r.rows });
});

app.get('/api/rooms/:roomId/messages', authMiddleware, async (req, res) => {
  const roomId = req.params.roomId;
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const before = req.query.before;

  if (!before) {
    const q = `
      SELECT m.id, m.room_id, m.sender_id, u.username as sender_name, m.content, m.created_at
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.room_id = $1
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2
    `;
    const r = await pool.query(q, [roomId, limit]);
    // Query is DESC for index efficiency; return ASC for chat UI (older above).
    return res.json({ items: r.rows.slice().reverse().map(rowToApi) });
  }

  const beforeRow = await pool.query('SELECT created_at, id FROM messages WHERE id = $1 AND room_id = $2', [before, roomId]);
  if (beforeRow.rowCount === 0) {
    return res.status(400).json({ message: 'invalid before cursor' });
  }
  const { created_at: beforeCreatedAt, id: beforeId } = beforeRow.rows[0];

  const q = `
    SELECT m.id, m.room_id, m.sender_id, u.username as sender_name, m.content, m.created_at
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.room_id = $1
      AND (m.created_at, m.id) < ($2, $3)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT $4
  `;
  const r = await pool.query(q, [roomId, beforeCreatedAt, beforeId, limit]);
  return res.json({ items: r.rows.slice().reverse().map(rowToApi) });
});

app.post('/api/messages', authMiddleware, async (req, res) => {
  const { roomId, idempotencyKey, content } = req.body || {};
  if (!roomId || !content) {
    return res.status(400).json({ message: 'roomId and content are required' });
  }

  const messageId = crypto.randomUUID();

  try {
    const q = `
      INSERT INTO messages (id, room_id, sender_id, content, client_msg_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, room_id, sender_id, content, created_at
    `;
    const r = await pool.query(q, [messageId, roomId, req.user.id, content, idempotencyKey || null]);
    const row = r.rows[0];

    const payload = {
      type: 'message',
      id: row.id,
      roomId: row.room_id,
      senderId: row.sender_id,
      senderName: req.user.username,
      content: row.content,
      createdAt: row.created_at,
    };

    await amqpCh.publish(EXCHANGE_NAME, `room.${roomId}`, Buffer.from(JSON.stringify(payload)), { persistent: true });
    return res.status(202).json({ messageId: row.id, status: 'stored' });
  } catch (e) {
    if (String(e?.code) === '23505') {
      // idempotency: duplicate client_msg_id for the same sender
      return res.status(200).json({ status: 'duplicate' });
    }
    // eslint-disable-next-line no-console
    console.error('send message error', e);
    return res.status(500).json({ message: 'internal error' });
  }
});

function rowToApi(r) {
  return {
    id: r.id,
    roomId: r.room_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    content: r.content,
    createdAt: r.created_at,
  };
}

async function main() {
  await initAmqp();

  // Ensure General room exists
  await pool.query("INSERT INTO rooms (id, name) VALUES ('general', 'General') ON CONFLICT (id) DO NOTHING");

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`message listening on ${PORT}`);
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal', e);
  process.exit(1);
});
