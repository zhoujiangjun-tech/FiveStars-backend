// 数据库初始化与封装
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'fivestars.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// 初始化 users 表（friend_code 为对外可见的数字好友码）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    friend_code TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 旧库兼容：如果 friend_code 字段不存在则添加
try {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.find((c) => c.name === 'friend_code')) {
    db.exec("ALTER TABLE users ADD COLUMN friend_code TEXT");
  }
} catch (e) {
  // ignore
}

// 为已存在但 friend_code 为空的旧用户补一个
function ensureCodes() {
  const rows = db.prepare("SELECT id FROM users WHERE friend_code IS NULL OR friend_code = ''").all();
  if (rows.length === 0) return;
  const upd = db.prepare("UPDATE users SET friend_code = ? WHERE id = ?");
  rows.forEach((r) => upd.run(generateUniqueCode(), r.id));
}

// 初始化 games 表
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_black_id INTEGER REFERENCES users(id),
    player_white_id INTEGER REFERENCES users(id),
    board_state TEXT NOT NULL,
    move_history TEXT DEFAULT '[]',
    current_turn TEXT NOT NULL,
    status TEXT DEFAULT 'playing',
    winner_id INTEGER,
    undo_count_black INTEGER DEFAULT 3,
    undo_count_white INTEGER DEFAULT 3,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
  );
`);

// 初始化好友关系表
// status: pending 等待对方接受；accepted 已互为好友；rejected 已拒绝
// 同一对用户只保留一条记录：user_id < friend_id 时小者放 user_id
db.exec(`
  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requester_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
  );
`);

// 生成 6 位数字好友码
function generateUniqueCode() {
  // 避免以 0 开头，方便显示
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const exist = db.prepare('SELECT 1 FROM users WHERE friend_code = ?').get(code);
    if (!exist) return code;
  }
  // 极端兜底：用时间戳后 6 位
  return String(Date.now()).slice(-6);
}

module.exports = db;
module.exports.generateUniqueCode = generateUniqueCode;
module.exports.ensureCodes = ensureCodes;
