// Точка входа: монтирует все роуты, защищает страницы, отдаёт HTML.
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

// Подключаем .env, если он есть (не обязательно — есть дефолты в коде).
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {}

require('./db'); // авто-инициализация БД и сидов

const { getCurrentUser, pickRedirectPage } = require('./middleware/auth');

const app = express();

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// API
app.use('/api/auth',  require('./routes/auth'));
app.use('/api',       require('./routes/admin'));
app.use('/api',       require('./routes/trucks'));
app.use('/api',       require('./routes/reports'));

// ============================================================
// HTML pages
// ============================================================
const PAGES_DIR = path.join(__dirname, 'public');
const PAGE_FILES = {
  login:    'login.html',
  operator: 'operator.html',
  client:   'client.html',
  admin:    'admin.html',
  noAccess: 'no-access.html',
};

function sendPage(res, file) {
  res.sendFile(path.join(PAGES_DIR, file));
}

function gated(pageId) {
  // Middleware: пускает только если у роли есть доступ к pageId.
  // Иначе — login (если не авторизован) или /no-access.
  return (req, res, next) => {
    const ctx = getCurrentUser(req);
    if (!ctx) return res.redirect('/login');
    if (!ctx.pages.includes(pageId)) return res.redirect('/no-access');
    req.auth = ctx;
    next();
  };
}

// /login — если уже авторизован, переадресовываем в его дом
app.get(['/', '/login'], (req, res) => {
  const ctx = getCurrentUser(req);
  if (ctx) return res.redirect(pickRedirectPage(ctx.pages));
  sendPage(res, PAGE_FILES.login);
});

app.get('/operator', gated('operator'), (_req, res) => sendPage(res, PAGE_FILES.operator));
app.get('/client',   gated('client'),   (_req, res) => sendPage(res, PAGE_FILES.client));
app.get('/admin',    gated('admin'),    (_req, res) => sendPage(res, PAGE_FILES.admin));
app.get('/no-access', (_req, res) => sendPage(res, PAGE_FILES.noAccess));

// Статика для общего клиентского JS и тривиальных ассетов
app.use(express.static(PAGES_DIR, { extensions: ['html'] }));

// 404 — для API json, для остального — login
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.redirect('/login');
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Meridian запущен → http://localhost:${PORT}`);
  console.log('Демо-логины: admin / op1 / cl1 (пароль 1234)');
});
