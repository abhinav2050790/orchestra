import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { authRequired, signToken } from '../middleware.js';
import { HttpError, isEmail, requireFields } from '../util.js';

const router = Router();
const SALT_ROUNDS = 10;

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

router.post('/register', (req, res) => {
  requireFields(req.body, ['name', 'email', 'password']);
  const { name, email, password } = req.body;
  if (!isEmail(email)) throw new HttpError(400, 'Invalid email');
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  try {
    const result = db
      .prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
      .run(email.toLowerCase().trim(), hash, name.trim());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'Email already registered');
    }
    throw err;
  }
});

router.post('/login', (req, res) => {
  requireFields(req.body, ['email', 'password']);
  const user = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(String(req.body.email).toLowerCase().trim());
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) {
    throw new HttpError(401, 'Invalid email or password');
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user: publicUser(user) });
});

export default router;
