// 认证相关：注册、登录、JWT 中间件
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'fivestars_secret_key_change_me';
const JWT_EXPIRES_IN = '7d';

function register(username, password) {
  if (!username || !password) {
    throw new Error('用户名和密码不能为空');
  }
  if (username.length < 2 || username.length > 20) {
    throw new Error('用户名长度需在 2-20 之间');
  }
  if (password.length < 6) {
    throw new Error('密码长度至少 6 位');
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    throw new Error('用户名已存在');
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const friend_code = db.generateUniqueCode();
  const result = db
    .prepare('INSERT INTO users (username, password_hash, friend_code) VALUES (?, ?, ?)')
    .run(username, password_hash, friend_code);

  const user = { id: result.lastInsertRowid, username, friendCode: friend_code };
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
  return { token, user };
}

function login(username, password) {
  if (!username || !password) {
    throw new Error('用户名和密码不能为空');
  }
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row) {
    throw new Error('用户名或密码错误');
  }
  const ok = bcrypt.compareSync(password, row.password_hash);
  if (!ok) {
    throw new Error('用户名或密码错误');
  }
  const user = { id: row.id, username: row.username, friendCode: row.friend_code };
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
  return { token, user };
}

// HTTP 接口鉴权中间件
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: '未提供 token' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token 无效或已过期' });
  }
}

// Socket.io 鉴权
function verifySocketToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

module.exports = {
  register,
  login,
  authMiddleware,
  verifySocketToken,
};
