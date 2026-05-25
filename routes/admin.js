// Админская часть — /api/users, /api/roles, /api/pages.
// Все эндпоинты защищены requirePage('admin').
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, uid } = require('../db');
const { requirePage } = require('../middleware/auth');

const router = express.Router();

const PAGES = [
  { id: 'operator', name: 'Центр оформления', description: 'Управление заявками и операциями' },
  { id: 'client',   name: 'Кабинет клиента',  description: 'Подача и отслеживание заявок' },
  { id: 'admin',    name: 'Управление',       description: 'Пользователи и роли (эта страница)' },
];
const VALID_PAGE_IDS = new Set(PAGES.map(p => p.id));
const LOGIN_RE = /^[a-zA-Z0-9]+$/;
const PASSWORD_MIN = 4;

// Защита: применяется только к admin-путям этого роутера.
// Раньше тут стоял глобальный `router.use(requirePage('admin'))` — он
// срабатывал даже на /api/trucks, потому что trucks-роутер тоже смонтирован
// на /api и admin-роутер успевал прогнать middleware раньше отказа routing.
const guard = requirePage('admin');

// ============================================================
// PAGES (статический справочник)
// ============================================================
router.get('/pages', guard, (_req, res) => res.json(PAGES));

// ============================================================
// ROLES
// ============================================================
function serializeRole(r) {
  let pages = [];
  try { pages = JSON.parse(r.pages || '[]'); } catch {}
  const userCount       = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(r.id).c;
  const activeUserCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role_id = ? AND status = 'ACTIVE'").get(r.id).c;
  return {
    id: r.id,
    name: r.name,
    isSystem: !!r.is_system,
    pages,
    userCount,
    activeUserCount,
  };
}

router.get('/roles', guard, (_req, res) => {
  const rows = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name COLLATE NOCASE').all();
  res.json(rows.map(serializeRole));
});

router.post('/roles', guard, (req, res) => {
  const { name, pages } = req.body || {};
  const trimmed = (name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Название роли не может быть пустым' });

  const dup = db.prepare('SELECT id FROM roles WHERE LOWER(name) = LOWER(?)').get(trimmed);
  if (dup) return res.status(409).json({ error: 'Роль с таким названием уже существует' });

  const pageIds = Array.isArray(pages) ? pages.filter(p => VALID_PAGE_IDS.has(p)) : [];
  const id = uid('role');
  db.prepare('INSERT INTO roles (id, name, is_system, pages) VALUES (?, ?, 0, ?)').run(id, trimmed, JSON.stringify(pageIds));
  const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  res.status(201).json(serializeRole(row));
});

router.patch('/roles/:id', guard, (req, res) => {
  const id = req.params.id;
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ error: 'Роль не найдена' });

  const updates = {};
  if (typeof req.body?.name === 'string') {
    const trimmed = req.body.name.trim();
    if (!trimmed) return res.status(400).json({ error: 'Название роли не может быть пустым' });
    const dup = db.prepare('SELECT id FROM roles WHERE LOWER(name) = LOWER(?) AND id != ?').get(trimmed, id);
    if (dup) return res.status(409).json({ error: 'Роль с таким названием уже существует' });
    updates.name = trimmed;
  }
  if (Array.isArray(req.body?.pages)) {
    const pageIds = req.body.pages.filter(p => VALID_PAGE_IDS.has(p));
    updates.pages = JSON.stringify(pageIds);
  }
  if (Object.keys(updates).length === 0) {
    return res.json(serializeRole(role));
  }
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE roles SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
  const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  res.json(serializeRole(row));
});

router.delete('/roles/:id', guard, (req, res) => {
  const id = req.params.id;
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ error: 'Роль не найдена' });
  if (role.is_system) return res.status(400).json({ error: 'Системную роль нельзя удалить' });
  const cnt = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(id).c;
  if (cnt > 0) return res.status(409).json({ error: 'Невозможно удалить роль — есть привязанные пользователи' });
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ============================================================
// USERS
// ============================================================
function serializeUser(u) {
  return {
    id: u.id,
    login: u.login,
    roleId: u.role_id,
    status: u.status,
    createdAt: u.created_at,
  };
}

router.get('/users', guard, (req, res) => {
  // Поддерживаем фильтрацию через query (search, roleId, status).
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  if (req.query.search) {
    sql += ' AND LOWER(login) LIKE ?';
    params.push('%' + String(req.query.search).toLowerCase() + '%');
  }
  if (req.query.roleId) {
    sql += ' AND role_id = ?';
    params.push(req.query.roleId);
  }
  if (req.query.status) {
    sql += ' AND status = ?';
    params.push(req.query.status);
  }
  sql += " ORDER BY CASE WHEN status='ACTIVE' THEN 0 ELSE 1 END, created_at DESC";
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(serializeUser));
});

router.post('/users', guard, (req, res) => {
  const { login, password, role_id: roleIdSnake, roleId: roleIdCamel } = req.body || {};
  const roleId = roleIdSnake || roleIdCamel;
  if (!login) return res.status(400).json({ error: 'Введите логин' });
  if (!LOGIN_RE.test(login)) {
    return res.status(400).json({ error: 'Логин содержит недопустимые символы. Разрешены только латинские буквы и цифры.' });
  }
  const dup = db.prepare("SELECT id FROM users WHERE LOWER(login) = LOWER(?) AND status = 'ACTIVE'").get(login);
  if (dup) return res.status(409).json({ error: 'Логин уже занят активным пользователем' });
  if (!password || String(password).length < PASSWORD_MIN) {
    return res.status(400).json({ error: `Пароль слишком короткий (минимум ${PASSWORD_MIN} символа)` });
  }
  if (!roleId) return res.status(400).json({ error: 'Выберите роль' });
  const role = db.prepare('SELECT id FROM roles WHERE id = ?').get(roleId);
  if (!role) return res.status(400).json({ error: 'Выбранная роль не найдена' });

  const id = uid('u');
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, login, password_hash, role_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, login, hash, roleId, 'ACTIVE', Date.now());
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json(serializeUser(row));
});

router.patch('/users/:id/password', guard, (req, res) => {
  const id = req.params.id;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  if (u.status !== 'ACTIVE') return res.status(400).json({ error: 'Пользователь деактивирован' });
  const password = req.body?.password;
  if (!password || String(password).length < PASSWORD_MIN) {
    return res.status(400).json({ error: `Пароль слишком короткий (минимум ${PASSWORD_MIN} символа)` });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  res.json({ ok: true });
});

router.post('/users/:id/activate', guard, (req, res) => {
  const id = req.params.id;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  if (u.status === 'ACTIVE') return res.status(400).json({ error: 'Пользователь уже активен' });

  // Защита от коллизии: уникальный частичный индекс users_login_active
  // не даёт двух ACTIVE с одинаковым login. Проверяем заранее — даём понятную ошибку.
  const conflict = db.prepare(
    "SELECT id FROM users WHERE LOWER(login) = LOWER(?) AND status = 'ACTIVE' AND id != ?"
  ).get(u.login, u.id);
  if (conflict) {
    return res.status(409).json({
      error: `Логин «${u.login}» сейчас занят активным пользователем — сначала деактивируйте его.`,
    });
  }

  db.prepare("UPDATE users SET status = 'ACTIVE' WHERE id = ?").run(id);
  res.json({ ok: true });
});

router.post('/users/:id/deactivate', guard, (req, res) => {
  const id = req.params.id;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  if (u.status !== 'ACTIVE') return res.status(400).json({ error: 'Пользователь уже деактивирован' });
  // Защита последнего активного админа
  if (u.role_id === 'role_admin') {
    const activeAdmins = db.prepare(
      "SELECT COUNT(*) c FROM users WHERE role_id = 'role_admin' AND status = 'ACTIVE'"
    ).get().c;
    if (activeAdmins <= 1) {
      return res.status(409).json({ error: 'Нельзя деактивировать единственного активного администратора' });
    }
  }
  db.prepare("UPDATE users SET status = 'INACTIVE' WHERE id = ?").run(id);
  res.json({ ok: true });
});

module.exports = router;
