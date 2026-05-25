// JWT-based аутентификация + проверка прав по странице.
const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET   = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE_NAME  = 'meridian_session';

function signToken(user) {
  // Срок жизни — год. JWT без жёсткого exp обновлять не нужно при сменах прав:
  // pages подтягиваются из БД на каждом запросе.
  return jwt.sign(
    { user_id: user.id, role_id: user.role_id, login: user.login },
    JWT_SECRET,
    { expiresIn: '365d' }
  );
}

function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function getCurrentUser(req) {
  // Возвращает { user, role, pages } или null.
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { return null; }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.user_id);
  if (!user || user.status !== 'ACTIVE') return null;
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(user.role_id);
  if (!role) return null;
  let pages = [];
  try { pages = JSON.parse(role.pages || '[]'); } catch {}
  return { user, role, pages };
}

function requireAuth(req, res, next) {
  const ctx = getCurrentUser(req);
  if (!ctx) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Не авторизован' });
  }
  req.auth = ctx;
  next();
}

function requirePage(pageId) {
  // Middleware-фабрика: пропускает только если роль имеет доступ к указанной странице.
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!req.auth.pages.includes(pageId)) {
        return res.status(403).json({ error: 'У вас нет доступа к этому ресурсу' });
      }
      next();
    });
  };
}

function pickRedirectPage(pages) {
  // Приоритет: admin → operator → client. См. модуль «Авторизация», п. 4.1.
  if (pages.includes('admin'))    return '/admin';
  if (pages.includes('operator')) return '/operator';
  if (pages.includes('client'))   return '/client';
  return '/no-access';
}

module.exports = {
  JWT_SECRET, COOKIE_NAME,
  signToken, setSessionCookie, clearSessionCookie,
  getCurrentUser, requireAuth, requirePage,
  pickRedirectPage,
};
