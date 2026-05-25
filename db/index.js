// Подключение к SQLite + автоинициализация схемы и сидов на первом запуске.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_DIR  = path.join(__dirname);
const DB_PATH = path.join(DB_DIR, 'meridian.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// SCHEMA
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_system INTEGER NOT NULL DEFAULT 0,
  pages     TEXT NOT NULL DEFAULT '[]'   -- JSON array
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | INACTIVE
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (role_id) REFERENCES roles(id)
);
-- Уникальный логин только среди активных пользователей
CREATE UNIQUE INDEX IF NOT EXISTS users_login_active
  ON users (LOWER(login)) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS trucks (
  id                    TEXT PRIMARY KEY,
  number                TEXT NOT NULL,
  client                TEXT,                              -- название компании (произвольная строка)
  customs               TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  current_stage_index   INTEGER NOT NULL DEFAULT 0,
  goods_count           INTEGER,
  weight                REAL,
  sum_amount            REAL,
  declaration_file      TEXT,
  prelim_info_file      TEXT,
  is_released           INTEGER NOT NULL DEFAULT 0,
  released_at           INTEGER,
  created_by_user_id    TEXT,
  assigned_operator_id  TEXT,                              -- кто взял заявку в работу
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  FOREIGN KEY (assigned_operator_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS trucks_client_idx     ON trucks(client);
CREATE INDEX IF NOT EXISTS trucks_released_idx   ON trucks(is_released);
CREATE INDEX IF NOT EXISTS trucks_created_at_idx ON trucks(created_at);

CREATE TABLE IF NOT EXISTS stage_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_id    TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  entered_at  INTEGER NOT NULL,
  exited_at   INTEGER,
  FOREIGN KEY (truck_id) REFERENCES trucks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS stage_history_truck_idx ON stage_history(truck_id);

CREATE TABLE IF NOT EXISTS problems (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_id     TEXT NOT NULL,
  stage_index  INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  reported_at  INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolve_note TEXT,
  FOREIGN KEY (truck_id) REFERENCES trucks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS problems_truck_idx ON problems(truck_id);

CREATE TABLE IF NOT EXISTS files (
  -- Метаданные физических файлов в uploads/
  -- stored_name — имя на диске (uuid+ext), original_name — для отображения
  truck_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- 'prelim' | 'declaration'
  stored_name   TEXT NOT NULL,
  original_name TEXT NOT NULL,
  uploaded_at   INTEGER NOT NULL,
  PRIMARY KEY (truck_id, kind),
  FOREIGN KEY (truck_id) REFERENCES trucks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ip_bans (
  ip               TEXT PRIMARY KEY,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  ban_until        INTEGER,
  last_attempt_at  INTEGER
);

CREATE TABLE IF NOT EXISTS counters (
  -- Для генерации id заявок: TR-YYYY-NNNN
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`);

// ============================================================
// MIGRATIONS — выполняются на каждом старте (идемпотентны)
// ============================================================
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
function migrate() {
  // 1) Добавить колонки weight / sum_amount / assigned_operator_id, если их нет
  if (!hasColumn('trucks', 'weight'))               db.exec('ALTER TABLE trucks ADD COLUMN weight REAL');
  if (!hasColumn('trucks', 'sum_amount'))           db.exec('ALTER TABLE trucks ADD COLUMN sum_amount REAL');
  if (!hasColumn('trucks', 'assigned_operator_id')) db.exec('ALTER TABLE trucks ADD COLUMN assigned_operator_id TEXT');
  // Индекс для отчётности по операторам
  db.exec('CREATE INDEX IF NOT EXISTS trucks_assignee_idx ON trucks(assigned_operator_id)');

  // 2) Сжатие схемы этапов с 10 до 8 (удалены border_crossed=3 и goods_marked=5).
  //    Старые индексы → новые: 0→0, 1→1, 2→2, 3→3 (пограничный), 4→3, 5→3,
  //    6→4, 7→5, 8→6, 9→7. Метим как «уже мигрировано» в counters, чтобы не двинуть дважды.
  const migRow = db.prepare("SELECT value FROM counters WHERE key='stages_v2_migrated'").get();
  if (!migRow) {
    const map = [0, 1, 2, 3, 3, 3, 4, 5, 6, 7]; // index = old, value = new
    const tx = db.transaction(() => {
      const trucks = db.prepare('SELECT id, current_stage_index FROM trucks').all();
      const upd = db.prepare('UPDATE trucks SET current_stage_index = ? WHERE id = ?');
      for (const t of trucks) upd.run(map[t.current_stage_index] ?? t.current_stage_index, t.id);

      const histRows = db.prepare('SELECT id, stage_index FROM stage_history').all();
      const updH = db.prepare('UPDATE stage_history SET stage_index = ? WHERE id = ?');
      for (const h of histRows) updH.run(map[h.stage_index] ?? h.stage_index, h.id);

      const probRows = db.prepare('SELECT id, stage_index FROM problems').all();
      const updP = db.prepare('UPDATE problems SET stage_index = ? WHERE id = ?');
      for (const p of probRows) updP.run(map[p.stage_index] ?? p.stage_index, p.id);

      db.prepare("INSERT OR REPLACE INTO counters (key, value) VALUES ('stages_v2_migrated', 1)").run();
    });
    tx();
  }
}

// ============================================================
// SEED
// ============================================================
function seedIfEmpty() {
  const rolesCount = db.prepare('SELECT COUNT(*) c FROM roles').get().c;
  if (rolesCount === 0) {
    const insRole = db.prepare('INSERT INTO roles (id, name, is_system, pages) VALUES (?, ?, ?, ?)');
    insRole.run('role_admin',    'Администратор', 1, JSON.stringify(['operator', 'client', 'admin']));
    insRole.run('role_operator', 'Оператор',      1, JSON.stringify(['operator']));
    insRole.run('role_client',   'Клиент',        1, JSON.stringify(['client']));
  }

  const usersCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (usersCount === 0) {
    const hash = (pwd) => bcrypt.hashSync(pwd, 10);
    const now = Date.now();
    const insUser = db.prepare(
      'INSERT INTO users (id, login, password_hash, role_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insUser.run('u_admin', 'admin', hash('1234'), 'role_admin',    'ACTIVE', now - 90 * 86400_000);
    insUser.run('u_op_1',  'op1',   hash('1234'), 'role_operator', 'ACTIVE', now - 28 * 86400_000);
    insUser.run('u_cl_1',  'cl1',   hash('1234'), 'role_client',   'ACTIVE', now - 21 * 86400_000);
  }

  const counterRow = db.prepare("SELECT value FROM counters WHERE key='truck_seq'").get();
  if (!counterRow) {
    db.prepare("INSERT INTO counters (key, value) VALUES ('truck_seq', 0)").run();
  }
}
migrate();
seedIfEmpty();

// ============================================================
// HELPERS
// ============================================================
function nextTruckId() {
  // Атомарный инкремент счётчика и форматирование ID.
  const row = db.prepare("SELECT value FROM counters WHERE key='truck_seq'").get();
  const next = (row.value || 0) + 1;
  db.prepare("UPDATE counters SET value = ? WHERE key='truck_seq'").run(next);
  const year = new Date().getFullYear();
  return `TR-${year}-${String(next).padStart(4, '0')}`;
}

function uid(prefix) {
  // Короткий уникальный идентификатор без зависимостей.
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

module.exports = { db, nextTruckId, uid };
