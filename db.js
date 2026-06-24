// 数据库：Turso 远程 SQLite（持久化存储）
const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 执行查询，返回第一条记录
async function get(sql, ...params) {
  const result = await client.execute({ sql, args: params });
  return result.rows[0] || null;
}

// 执行查询，返回全部记录
async function all(sql, ...params) {
  const result = await client.execute({ sql, args: params });
  return result.rows;
}

// 执行写操作，返回 changes 和 lastInsertRowid
async function run(sql, ...params) {
  const result = await client.execute({ sql, args: params });
  return {
    changes: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid ? Number(result.lastInsertRowid) : undefined,
  };
}

// 执行原始 SQL（建表等）
async function exec(sql) {
  await client.execute(sql);
}

// 初始化表结构
async function initTables() {
  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      friend_code TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await exec(`
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

  await exec(`
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
}

// 生成 6 位数字好友码
async function generateUniqueCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const exist = await get('SELECT 1 FROM users WHERE friend_code = ?', code);
    if (!exist) return code;
  }
  return String(Date.now()).slice(-6);
}

// 旧用户补好友码
async function ensureCodes() {
  const rows = await all("SELECT id FROM users WHERE friend_code IS NULL OR friend_code = ''");
  for (const r of rows) {
    await run('UPDATE users SET friend_code = ? WHERE id = ?', await generateUniqueCode(), r.id);
  }
}

module.exports = { get, all, run, exec, initTables, generateUniqueCode, ensureCodes };