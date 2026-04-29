import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({ connectionString: DATABASE_URL });

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'username and password are required' });
  }

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const q = 'INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username';
    const r = await pool.query(q, [id, username, passwordHash]);
    return res.status(201).json({ userId: r.rows[0].id, username: r.rows[0].username });
  } catch (e) {
    if (String(e?.code) === '23505') {
      return res.status(409).json({ message: 'username already exists' });
    }
    // eslint-disable-next-line no-console
    console.error('register error', e);
    return res.status(500).json({ message: 'internal error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'username and password are required' });
  }

  try {
    const q = 'SELECT id, username, password_hash FROM users WHERE username = $1';
    const r = await pool.query(q, [username]);
    if (r.rowCount === 0) {
      return res.status(401).json({ message: 'invalid credentials' });
    }

    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ message: 'invalid credentials' });
    }

    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, userId: user.id, username: user.username });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('login error', e);
    return res.status(500).json({ message: 'internal error' });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`auth listening on ${PORT}`);
});
