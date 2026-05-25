// /api/auth/* — вход, выход, текущий пользователь, защита от перебора по IP.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const {
  signToken, setSessionCookie, clearSessionCookie,
  getCurrentUser, pickRedirectPage,
} = require('../middleware/auth');

const router = express.Router();

const MAX_ATTEMPTS    = 10;
const BAN_DURATION_MS = 10 * 60 * 1000;

function getClientIp(req) {
  // X-Forwarded-For предпочтительнее, но игнорируем его без trust proxy в dev.
  const xff = req.headers['x-forwarded-for'];
  if (xff && process.env.NODE_ENV === 'production') {
    return String(xff).split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function getBan(ip) {
  return db.prepare('SELECT * FROM ip_bans WHERE ip = ?').get(ip);
}

function bumpFailed(ip) {
  const now = Date.now();
  const row = getBan(ip);
  if (!row) {
    db.prepare(
      'INSERT INTO ip_bans (ip, failed_attempts, ban_until, last_attempt_at) VALUES (?, 1, NULL, ?)'
    ).run(ip, now);
    return 1;
  }
  const newCount = (row.failed_attempts || 0) + 1;
  const banUntil = newCount >= MAX_ATTEMPTS ? now + BAN_DURATION_MS : null;
  db.prepare(
    'UPDATE ip_bans SET failed_attempts = ?, ban_until = ?, last_attempt_at = ? WHERE ip = ?'
  ).run(newCount, banUntil, now, ip);
  return newCount;
}

function resetFailed(ip) {
  db.prepare('DELETE FROM ip_bans WHERE ip = ?').run(ip);
}

router.post('/login', (req, res) => {
  const ip = getClientIp(req);

  // 1. Проверка бана
  const ban = getBan(ip);
  if (ban?.ban_until && ban.ban_until > Date.now()) {
    const secondsLeft = Math.ceil((ban.ban_until - Date.now()) / 1000);
    const minutesLeft = Math.ceil(secondsLeft / 60);
    return res.status(429).json({
      error: `Слишком много попыток входа. Повторите через ${minutesLeft} мин.`,
      banUntil: ban.ban_until,
      secondsLeft,
    });
  }

  const { login, password } = req.body || {};

  // 2. Пустые поля (на всякий случай, фронт сам валидирует)
  if (!login || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }

  // 3. Поиск пользователя — без учёта регистра
  const user = db.prepare('SELECT * FROM users WHERE LOWER(login) = LOWER(?)').get(login);
  const fail = () => {
    const count = bumpFailed(ip);
    if (count >= MAX_ATTEMPTS) {
      const ban2 = getBan(ip);
      const secondsLeft = Math.ceil((ban2.ban_until - Date.now()) / 1000);
      const minutesLeft = Math.ceil(secondsLeft / 60);
      return res.status(429).json({
        error: `Слишком много попыток входа. Повторите через ${minutesLeft} мин.`,
        banUntil: ban2.ban_until,
        secondsLeft,
      });
    }
    return res.status(401).json({ error: 'Неверный логин или пароль', attempts: count, maxAttempts: MAX_ATTEMPTS });
  };

  if (!user) return fail();
  if (user.status !== 'ACTIVE') return fail();   // не раскрываем причину — единое сообщение
  if (!bcrypt.compareSync(password, user.password_hash)) return fail();

  // 4. Успех
  resetFailed(ip);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(user.role_id);
  let pages = [];
  try { pages = JSON.parse(role?.pages || '[]'); } catch {}
  const redirect = pickRedirectPage(pages);

  const token = signToken(user);
  setSessionCookie(req, res, token);

  return res.json({
    user_id: user.id,
    login: user.login,
    role_id: user.role_id,
    role_name: role?.name || '',
    pages,
    redirect,
  });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const ctx = getCurrentUser(req);
  if (!ctx) return res.status(401).json({ error: 'Не авторизован' });
  res.json({
    user_id: ctx.user.id,
    login:   ctx.user.login,
    role_id: ctx.user.role_id,
    role_name: ctx.role.name,
    pages:   ctx.pages,
  });
});

// Только для dev: ручной сброс бана (используется в демо-блоке login.html).
router.post('/_reset_attempts', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  const ip = getClientIp(req);
  resetFailed(ip);
  res.json({ ok: true });
});

module.exports = router;
