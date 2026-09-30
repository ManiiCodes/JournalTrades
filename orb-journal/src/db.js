// Postgres in production (DATABASE_URL, e.g. a free Neon database).
// Without DATABASE_URL it falls back to an embedded Postgres (PGlite) stored in DATA_DIR, for local use.
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let driver = null; // { query(sql, params) -> rows, tx(fn) }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  firm TEXT NOT NULL DEFAULT 'Other',
  kind TEXT NOT NULL DEFAULT '',
  connection_id TEXT,
  tv_env TEXT,
  tv_account_id BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_user ON accounts(user_id);
CREATE TABLE IF NOT EXISTS connections(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  env TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enc_creds TEXT,
  enc_token TEXT,
  token_expires BIGINT,
  status TEXT NOT NULL DEFAULT 'ok',
  last_sync_at BIGINT,
  last_error TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS trades(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  entry_ts BIGINT,
  root TEXT,
  side TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  data TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_user_ts ON trades(user_id, entry_ts);
CREATE TABLE IF NOT EXISTS legs(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL,
  source TEXT NOT NULL,
  symbol TEXT, root TEXT, side TEXT,
  qty DOUBLE PRECISION, entry DOUBLE PRECISION, exit DOUBLE PRECISION,
  gross DOUBLE PRECISION, fees DOUBLE PRECISION,
  entry_ts BIGINT, exit_ts BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS legs_ext ON legs(user_id, external_id);
CREATE INDEX IF NOT EXISTS legs_trade ON legs(trade_id);
CREATE INDEX IF NOT EXISTS legs_acct_ts ON legs(user_id, account_id, entry_ts);
CREATE TABLE IF NOT EXISTS ignored_legs(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  PRIMARY KEY(user_id, external_id)
);
CREATE TABLE IF NOT EXISTS oauth_states(
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  env TEXT NOT NULL,
  label TEXT,
  expires_at BIGINT NOT NULL
);
`;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number (epoch ms fits safely)
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.delete('channel_binding');
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (!local && !url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require');
    const pool = new Pool({ connectionString: url.toString(), max: Math.max(1, Number(process.env.DB_POOL_MAX) || 5), idleTimeoutMillis: 30000, connectionTimeoutMillis: 20000 });
    pool.on('error', e => console.error('postgres pool error:', e.message));
    driver = {
      kind: 'postgres',
      query: (sql, params) => pool.query(sql, params).then(r => r.rows),
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn((sql, params) => c.query(sql, params).then(r => r.rows));
          await c.query('COMMIT');
          return out;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      },
    };
  } else {
    if (process.env.RENDER) throw new Error('DATABASE_URL is not set. Add your Neon connection string in Render → Environment.');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite(path.join(DATA_DIR, 'pgdata'), { parsers: { 20: v => parseInt(v, 10) } });
    driver = {
      kind: 'embedded',
      query: (sql, params) => pg.query(sql, params).then(r => r.rows),
      tx: fn => pg.transaction(t => fn((sql, params) => t.query(sql, params).then(r => r.rows))),
    };
  }
  await driver.query('SELECT 1');
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) await driver.query(stmt);
  return driver.kind;
}

// Each statement exposes get/all/run. Pass `x` (from tx) to run inside a transaction.
const stmt = sql => ({
  all: (params = [], x) => (x || driver.query)(sql, params),
  get: async (params = [], x) => (await (x || driver.query)(sql, params))[0],
  run: (params = [], x) => (x || driver.query)(sql, params),
});
const tx = fn => driver.tx(fn);

const q = {
  // users & sessions
  userByEmail: stmt('SELECT * FROM users WHERE email = $1'),
  insertUser: stmt('INSERT INTO users(id,email,pass_hash,created_at) VALUES($1,$2,$3,$4)'),
  insertSession: stmt('INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)'),
  getSession: stmt('SELECT s.user_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > $2'),
  deleteSession: stmt('DELETE FROM sessions WHERE id = $1'),
  purgeSessions: stmt('DELETE FROM sessions WHERE expires_at < $1'),

  // settings
  getSettings: stmt('SELECT data FROM settings WHERE user_id = $1'),
  putSettings: stmt('INSERT INTO settings(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data = EXCLUDED.data'),

  // accounts
  accountsForUser: stmt('SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at'),
  accountById: stmt('SELECT * FROM accounts WHERE id = $1 AND user_id = $2'),
  accountByTv: stmt('SELECT * FROM accounts WHERE user_id = $1 AND tv_env = $2 AND tv_account_id = $3'),
  insertAccount: stmt('INSERT INTO accounts(id,user_id,name,firm,kind,connection_id,tv_env,tv_account_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)'),
  updateAccount: stmt('UPDATE accounts SET name = $1, firm = $2, kind = $3 WHERE id = $4 AND user_id = $5'),
  relinkAccount: stmt('UPDATE accounts SET connection_id = $1 WHERE id = $2'),
  deleteAccount: stmt('DELETE FROM accounts WHERE id = $1 AND user_id = $2'),
  unlinkConnectionAccounts: stmt('UPDATE accounts SET connection_id = NULL WHERE connection_id = $1 AND user_id = $2'),

  // connections
  connectionsForUser: stmt('SELECT * FROM connections WHERE user_id = $1 ORDER BY created_at'),
  connectionById: stmt('SELECT * FROM connections WHERE id = $1 AND user_id = $2'),
  activeConnections: stmt("SELECT * FROM connections WHERE status IN ('ok','error')"),
  insertConnection: stmt('INSERT INTO connections(id,user_id,method,env,label,enc_creds,enc_token,token_expires,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)'),
  saveToken: stmt('UPDATE connections SET enc_token = $1, token_expires = $2 WHERE id = $3'),
  setConnStatus: stmt('UPDATE connections SET status = $1, last_error = $2 WHERE id = $3'),
  markSynced: stmt("UPDATE connections SET status = 'ok', last_error = NULL, last_sync_at = $1 WHERE id = $2"),
  deleteConnection: stmt('DELETE FROM connections WHERE id = $1 AND user_id = $2'),

  // oauth state
  insertState: stmt('INSERT INTO oauth_states(state,user_id,env,label,expires_at) VALUES($1,$2,$3,$4,$5)'),
  takeState: stmt('DELETE FROM oauth_states WHERE state = $1 RETURNING *'),
  purgeStates: stmt('DELETE FROM oauth_states WHERE expires_at < $1'),

  // trades
  tradesForUser: stmt('SELECT * FROM trades WHERE user_id = $1 ORDER BY entry_ts, date'),
  tradeById: stmt('SELECT * FROM trades WHERE id = $1 AND user_id = $2'),
  insertTrade: stmt('INSERT INTO trades(id,user_id,date,entry_ts,root,side,source,data,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)'),
  updateTrade: stmt('UPDATE trades SET date = $1, entry_ts = $2, root = $3, side = $4, source = $5, data = $6, updated_at = $7 WHERE id = $8'),
  deleteTrade: stmt('DELETE FROM trades WHERE id = $1 AND user_id = $2'),
  tradesNear: stmt('SELECT * FROM trades WHERE user_id = $1 AND root = $2 AND side = $3 AND entry_ts BETWEEN $4 AND $5'),

  // legs
  legsForUser: stmt('SELECT * FROM legs WHERE user_id = $1 ORDER BY entry_ts'),
  legsForTrade: stmt('SELECT * FROM legs WHERE trade_id = $1 ORDER BY entry_ts, id'),
  legByExt: stmt('SELECT * FROM legs WHERE user_id = $1 AND external_id = $2'),
  dupLegs: stmt('SELECT * FROM legs WHERE user_id = $1 AND account_id IS NOT DISTINCT FROM $2 AND side = $3 AND entry_ts BETWEEN $4 AND $5'),
  insertLeg: stmt(`INSERT INTO legs(id,user_id,trade_id,account_id,external_id,source,symbol,root,side,qty,entry,exit,gross,fees,entry_ts,exit_ts)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`),
  updateLeg: stmt('UPDATE legs SET account_id = $1, qty = $2, entry = $3, exit = $4, gross = $5, fees = $6, entry_ts = $7, exit_ts = $8 WHERE id = $9'),
  ignoreLeg: stmt('INSERT INTO ignored_legs(user_id,external_id) VALUES($1,$2) ON CONFLICT DO NOTHING'),
  isIgnored: stmt('SELECT 1 AS x FROM ignored_legs WHERE user_id = $1 AND external_id = $2'),
};

module.exports = { init, q, tx, DATA_DIR };
