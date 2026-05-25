// /api/trucks/* — заявки. Доступы:
//   operator — видит и меняет всё;
//   client   — видит и создаёт только свои.
// Также /api/clients (динамический) и /api/customs (статический).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, nextTruckId } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Этапы сжаты с 10 до 8: убраны `border_crossed` и `goods_marked`.
// «Отметка товаров» больше не отдельный этап — обязательность заполнения
// goodsCount / weight / sum переехала в предусловие перехода с `arrived`.
const STAGES = [
  'pending', 'prelim_filling', 'prelim_done',
  'arrived',
  'customs',
  'declaration', 'docs_submitted', 'released'
];
const TOTAL_STAGES = STAGES.length;
const FINAL_STAGE  = TOTAL_STAGES - 1; // 7
const ARRIVED_STAGE = 3;
const CUSTOMS_OFFICES = ['Кара-Булак', 'Кант', 'Балыкчы', 'Манас'];
const ALLOWED_EXTS = new Set(['.pdf', '.doc', '.docx', '.xml']);

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename:    (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 МБ — с запасом для PDF деклараций
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) return cb(new Error('Недопустимый формат файла. Разрешены: PDF, DOC, DOCX, XML'));
    cb(null, true);
  }
});

// ============================================================
// HELPERS
// ============================================================
function isOperator(req) { return req.auth.pages.includes('operator'); }
function isClient(req)   { return req.auth.pages.includes('client'); }

function hasAnyTruckAccess(req) {
  return isOperator(req) || isClient(req);
}

function clientLabelForUser(req) {
  // У клиента имя организации = его login (упрощение для MVP).
  // Реальный сервис связывал бы пользователя с client_id из отдельной таблицы.
  return req.auth.user.login;
}

function loadTruckFull(truckId) {
  const t = db.prepare('SELECT * FROM trucks WHERE id = ?').get(truckId);
  if (!t) return null;
  const history = db.prepare(
    'SELECT stage_index, entered_at, exited_at FROM stage_history WHERE truck_id = ? ORDER BY id'
  ).all(truckId);
  const problems = db.prepare(
    'SELECT stage_index, reason, reported_at, resolved_at, resolve_note FROM problems WHERE truck_id = ? ORDER BY id'
  ).all(truckId);
  let assignedOperatorLogin = null;
  if (t.assigned_operator_id) {
    const op = db.prepare('SELECT login FROM users WHERE id = ?').get(t.assigned_operator_id);
    assignedOperatorLogin = op?.login || null;
  }
  return {
    id: t.id,
    number: t.number,
    client: t.client,
    customs: t.customs,
    createdAt: t.created_at,
    currentStageIndex: t.current_stage_index,
    goodsCount: t.goods_count,
    declarationFile: t.declaration_file,
    prelimInfoFile: t.prelim_info_file,
    weight: t.weight,
    sumAmount: t.sum_amount,
    isReleased: !!t.is_released,
    releasedAt: t.released_at,
    assignedOperatorId: t.assigned_operator_id,
    assignedOperatorLogin,
    stageHistory: history.map(h => ({
      stageIndex: h.stage_index, enteredAt: h.entered_at, exitedAt: h.exited_at
    })),
    problems: problems.map(p => ({
      stageIndex: p.stage_index, reason: p.reason,
      reportedAt: p.reported_at, resolvedAt: p.resolved_at, resolveNote: p.resolve_note
    })),
  };
}

function canAccessTruck(req, truck) {
  if (isOperator(req)) return true;
  if (isClient(req))   return truck.client === clientLabelForUser(req);
  return false;
}

function findCurrentStageEntry(truckId) {
  return db.prepare(
    'SELECT id, stage_index, entered_at FROM stage_history WHERE truck_id = ? AND exited_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(truckId);
}

function deleteStoredFile(storedName) {
  if (!storedName) return;
  const p = path.join(UPLOAD_DIR, storedName);
  fs.promises.unlink(p).catch(() => {}); // молча игнорируем отсутствие
}

// ============================================================
// LIST + ONE
// ============================================================
router.get('/trucks', requireAuth, (req, res) => {
  if (!hasAnyTruckAccess(req)) return res.status(403).json({ error: 'Нет доступа' });
  let sql = 'SELECT id FROM trucks';
  const params = [];
  if (!isOperator(req)) {
    sql += ' WHERE client = ?';
    params.push(clientLabelForUser(req));
  }
  sql += ' ORDER BY created_at DESC';
  const ids = db.prepare(sql).all(...params).map(r => r.id);
  res.json(ids.map(loadTruckFull));
});

router.get('/trucks/:id', requireAuth, (req, res) => {
  if (!hasAnyTruckAccess(req)) return res.status(403).json({ error: 'Нет доступа' });
  const t = loadTruckFull(req.params.id);
  if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
  if (!canAccessTruck(req, t)) return res.status(403).json({ error: 'Нет доступа к этой заявке' });
  res.json(t);
});

// ============================================================
// CREATE (оператор или клиент)
// ============================================================
router.post('/trucks', requireAuth, (req, res) => {
  if (!hasAnyTruckAccess(req)) return res.status(403).json({ error: 'Нет доступа' });
  const { number, customs, client } = req.body || {};

  const trimmedNumber = (number || '').trim();
  if (!trimmedNumber) return res.status(400).json({ error: 'Введите номер машины' });
  if (!customs) return res.status(400).json({ error: 'Выберите таможню' });
  if (!CUSTOMS_OFFICES.includes(customs)) {
    return res.status(400).json({ error: 'Неизвестная таможня' });
  }
  // Уникальность среди активных
  const dup = db.prepare(
    "SELECT id FROM trucks WHERE is_released = 0 AND LOWER(number) = LOWER(?)"
  ).get(trimmedNumber);
  if (dup) {
    return res.status(409).json({ error: `Номер уже используется заявкой ${dup.id}. Дождитесь её выпуска.` });
  }

  // Клиент: у клиента всегда берётся из сессии. У оператора — из тела.
  const clientLabel = isClient(req) && !isOperator(req)
    ? clientLabelForUser(req)
    : ((client || '').trim() || null);

  const id  = nextTruckId();
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO trucks
        (id, number, client, customs, created_at, current_stage_index,
         goods_count, declaration_file, prelim_info_file, is_released, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 0, ?)`
    ).run(id, trimmedNumber, clientLabel, customs, now, req.auth.user.id);
    db.prepare(
      'INSERT INTO stage_history (truck_id, stage_index, entered_at, exited_at) VALUES (?, 0, ?, NULL)'
    ).run(id, now);
  });
  tx();
  res.status(201).json(loadTruckFull(id));
});

// ============================================================
// PATCH (goodsCount) — только оператор
// ============================================================
router.patch('/trucks/:id', requireAuth, (req, res) => {
  if (!isOperator(req)) return res.status(403).json({ error: 'Только оператор может изменять заявку' });
  const t = loadTruckFull(req.params.id);
  if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
  if (t.isReleased) return res.status(400).json({ error: 'Заявка уже выпущена' });

  // Поля «прибытия» фиксируются (нельзя обнулить) после перехода за arrived.
  const frozen = t.currentStageIndex > ARRIVED_STAGE;

  // goodsCount — целое ≥ 1
  if ('goodsCount' in req.body) {
    const raw = req.body.goodsCount;
    if (raw === null || raw === '') {
      if (frozen) return res.status(400).json({ error: 'Количество товаров уже зафиксировано — нельзя обнулить' });
      db.prepare('UPDATE trucks SET goods_count = NULL WHERE id = ?').run(t.id);
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'Введите положительное число (товары)' });
      db.prepare('UPDATE trucks SET goods_count = ? WHERE id = ?').run(n, t.id);
    }
  }

  // weight — число > 0 (кг, дробное допустимо)
  if ('weight' in req.body) {
    const raw = req.body.weight;
    if (raw === null || raw === '') {
      if (frozen) return res.status(400).json({ error: 'Вес уже зафиксирован — нельзя обнулить' });
      db.prepare('UPDATE trucks SET weight = NULL WHERE id = ?').run(t.id);
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Введите положительное число (вес)' });
      db.prepare('UPDATE trucks SET weight = ? WHERE id = ?').run(n, t.id);
    }
  }

  // sumAmount — число > 0 (валюта, дробное допустимо)
  if ('sumAmount' in req.body) {
    const raw = req.body.sumAmount;
    if (raw === null || raw === '') {
      if (frozen) return res.status(400).json({ error: 'Сумма уже зафиксирована — нельзя обнулить' });
      db.prepare('UPDATE trucks SET sum_amount = NULL WHERE id = ?').run(t.id);
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Введите положительное число (сумма)' });
      db.prepare('UPDATE trucks SET sum_amount = ? WHERE id = ?').run(n, t.id);
    }
  }

  res.json(loadTruckFull(t.id));
});

// ============================================================
// ADVANCE STAGE
// ============================================================
router.post('/trucks/:id/advance', requireAuth, (req, res) => {
  if (!isOperator(req)) return res.status(403).json({ error: 'Только оператор может переводить этапы' });
  const t = loadTruckFull(req.params.id);
  if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
  if (t.isReleased) return res.status(400).json({ error: 'Заявка уже выпущена' });

  // Бэкенд-валидации перехода.
  // Prelim-файл больше НЕ требуется — оператор загружает его в любое время.
  // На этапе «Прибытие на ВЗТК» нужно указать количество товаров, вес и сумму.
  if (t.currentStageIndex === ARRIVED_STAGE) {
    const missing = [];
    if (t.goodsCount === null || t.goodsCount === undefined) missing.push('количество товаров');
    if (t.weight === null     || t.weight === undefined)     missing.push('вес');
    if (t.sumAmount === null  || t.sumAmount === undefined)  missing.push('сумму');
    if (missing.length) {
      return res.status(400).json({ error: 'Заполните: ' + missing.join(', ') });
    }
  }

  const now = Date.now();
  const newIndex = t.currentStageIndex + 1;
  const becomesReleased = newIndex === FINAL_STAGE;

  // Auto-assign: первый, кто взял в работу из ожидания (0 → 1), берёт ответственность на себя,
  // если ещё никто не назначен. После выпуска ответственный фиксируется.
  const shouldAutoAssign = !t.assignedOperatorId && t.currentStageIndex === 0;

  const tx = db.transaction(() => {
    const cur = findCurrentStageEntry(t.id);
    if (cur) {
      db.prepare('UPDATE stage_history SET exited_at = ? WHERE id = ?').run(now, cur.id);
    }
    db.prepare(
      'INSERT INTO stage_history (truck_id, stage_index, entered_at, exited_at) VALUES (?, ?, ?, ?)'
    ).run(t.id, newIndex, now, becomesReleased ? now : null);
    db.prepare(
      'UPDATE trucks SET current_stage_index = ?, is_released = ?, released_at = ? WHERE id = ?'
    ).run(newIndex, becomesReleased ? 1 : 0, becomesReleased ? now : null, t.id);
    if (shouldAutoAssign) {
      db.prepare('UPDATE trucks SET assigned_operator_id = ? WHERE id = ?').run(req.auth.user.id, t.id);
    }
  });
  tx();
  res.json(loadTruckFull(t.id));
});

// ============================================================
// ASSIGN / UNASSIGN — закрепление ответственного оператора
// ============================================================
router.post('/trucks/:id/assign', requireAuth, (req, res) => {
  if (!isOperator(req)) return res.status(403).json({ error: 'Только оператор может назначать ответственного' });
  const t = loadTruckFull(req.params.id);
  if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
  if (t.isReleased) return res.status(400).json({ error: 'Заявка выпущена — ответственного нельзя изменить' });

  // Если userId не передан — назначаем себя. Если передан — это override (например, админ
  // переназначает на другого оператора). Право переназначать любого = доступ к admin.
  const isAdmin = req.auth.pages.includes('admin');
  let targetId = req.body?.userId;
  if (!targetId) {
    targetId = req.auth.user.id;
  } else if (targetId !== req.auth.user.id && !isAdmin) {
    return res.status(403).json({ error: 'Передать заявку другому оператору может только администратор' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(400).json({ error: 'Пользователь не найден' });
  if (target.status !== 'ACTIVE') return res.status(400).json({ error: 'Пользователь деактивирован' });
  const targetRole = db.prepare('SELECT pages FROM roles WHERE id = ?').get(target.role_id);
  let targetPages = [];
  try { targetPages = JSON.parse(targetRole?.pages || '[]'); } catch {}
  if (!targetPages.includes('operator')) {
    return res.status(400).json({ error: 'У выбранного пользователя нет доступа к роли оператора' });
  }

  db.prepare('UPDATE trucks SET assigned_operator_id = ? WHERE id = ?').run(targetId, t.id);
  res.json(loadTruckFull(t.id));
});

router.post('/trucks/:id/unassign', requireAuth, (req, res) => {
  if (!isOperator(req)) return res.status(403).json({ error: 'Только оператор может снимать ответственного' });
  const t = loadTruckFull(req.params.id);
  if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
  if (t.isReleased) return res.status(400).json({ error: 'Заявка выпущена — ответственного нельзя изменить' });
  db.prepare('UPDATE trucks SET assigned_operator_id = NULL WHERE id = ?').run(t.id);
  res.json(loadTruckFull(t.id));
});

// ============================================================
// PROBLEM
// ============================================================
router.post('/trucks/:id/problem', requireAuth, (req, res) => {
  if (!isOperator(req)) return res.status(403).json({ error: 'Только оператор фиксирует проблемы' });
  const t = loadTruckFull(req.params.id);
  if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
  if (t.isReleased) return res.status(400).json({ error: 'Заявка уже выпущена' });

  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Укажите причину проблемы' });

  db.prepare(
    `INSERT INTO problems (truck_id, stage_index, reason, reported_at, resolved_at, resolve_note)
     VALUES (?, ?, ?, ?, NULL, NULL)`
  ).run(t.id, t.currentStageIndex, reason, Date.now());
  res.json(loadTruckFull(t.id));
});

router.post('/trucks/:id/problem/resolve', requireAuth, (req, res) => {
  if (!isOperator(req)) return res.status(403).json({ error: 'Только оператор снимает проблемы' });
  const t = loadTruckFull(req.params.id);
  if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
  if (t.isReleased) return res.status(400).json({ error: 'Заявка уже выпущена' });

  const note = (req.body?.note || '').trim() || null;
  db.prepare(
    `UPDATE problems SET resolved_at = ?, resolve_note = ?
     WHERE truck_id = ? AND stage_index = ? AND resolved_at IS NULL`
  ).run(Date.now(), note, t.id, t.currentStageIndex);
  res.json(loadTruckFull(t.id));
});

// ============================================================
// FILES: prelim + declaration
// ============================================================
function uploadFor(kind) {
  return (req, res) => {
    if (!isOperator(req)) return res.status(403).json({ error: 'Только оператор загружает файлы' });
    const t = loadTruckFull(req.params.id);
    if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
    if (t.isReleased) return res.status(400).json({ error: 'Заявка уже выпущена' });
    if (!req.file) return res.status(400).json({ error: 'Файл не передан' });

    // Старый файл (если есть) — удаляем с диска
    const old = db.prepare('SELECT stored_name FROM files WHERE truck_id = ? AND kind = ?').get(t.id, kind);
    if (old) deleteStoredFile(old.stored_name);

    const original = req.file.originalname;
    const stored   = req.file.filename;

    db.prepare(
      `INSERT INTO files (truck_id, kind, stored_name, original_name, uploaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(truck_id, kind) DO UPDATE SET
         stored_name   = excluded.stored_name,
         original_name = excluded.original_name,
         uploaded_at   = excluded.uploaded_at`
    ).run(t.id, kind, stored, original, Date.now());

    const col = kind === 'prelim' ? 'prelim_info_file' : 'declaration_file';
    db.prepare(`UPDATE trucks SET ${col} = ? WHERE id = ?`).run(original, t.id);

    res.json(loadTruckFull(t.id));
  };
}

function deleteFor(kind, opts) {
  return (req, res) => {
    if (!isOperator(req)) return res.status(403).json({ error: 'Только оператор удаляет файлы' });
    const t = loadTruckFull(req.params.id);
    if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
    if (t.isReleased) return res.status(400).json({ error: 'Заявка уже выпущена' });
    if (opts?.onlyStage !== undefined && t.currentStageIndex !== opts.onlyStage) {
      return res.status(400).json({ error: 'Удаление недоступно на текущем этапе' });
    }
    const row = db.prepare('SELECT stored_name FROM files WHERE truck_id = ? AND kind = ?').get(t.id, kind);
    if (row) deleteStoredFile(row.stored_name);
    db.prepare('DELETE FROM files WHERE truck_id = ? AND kind = ?').run(t.id, kind);
    const col = kind === 'prelim' ? 'prelim_info_file' : 'declaration_file';
    db.prepare(`UPDATE trucks SET ${col} = NULL WHERE id = ?`).run(t.id);
    res.json(loadTruckFull(t.id));
  };
}

function downloadFor(kind) {
  return (req, res) => {
    const t = loadTruckFull(req.params.id);
    if (!t) return res.status(404).json({ error: 'Заявка не найдена' });
    if (!canAccessTruck(req, t)) return res.status(403).json({ error: 'Нет доступа' });
    const row = db.prepare('SELECT * FROM files WHERE truck_id = ? AND kind = ?').get(t.id, kind);
    if (!row) return res.status(404).json({ error: 'Файл не найден' });
    const p = path.join(UPLOAD_DIR, row.stored_name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Файл недоступен' });
    res.download(p, row.original_name);
  };
}

router.post('/trucks/:id/prelim-file',   requireAuth, upload.single('file'), uploadFor('prelim'));
router.delete('/trucks/:id/prelim-file', requireAuth, deleteFor('prelim', { onlyStage: 1 }));
router.get('/trucks/:id/prelim-file/download',   requireAuth, downloadFor('prelim'));

router.post('/trucks/:id/declaration',   requireAuth, upload.single('file'), uploadFor('declaration'));
router.delete('/trucks/:id/declaration', requireAuth, deleteFor('declaration'));
router.get('/trucks/:id/declaration/download',   requireAuth, downloadFor('declaration'));

// ============================================================
// CLIENTS + CUSTOMS
// ============================================================
router.get('/clients', requireAuth, (req, res) => {
  if (!isOperator(req)) return res.status(403).json({ error: 'Доступно только оператору' });
  // Динамический список из заявок.
  const rows = db.prepare(
    "SELECT DISTINCT client FROM trucks WHERE client IS NOT NULL AND TRIM(client) != '' ORDER BY client COLLATE NOCASE"
  ).all();
  res.json(rows.map(r => r.client));
});

router.get('/customs', requireAuth, (_req, res) => {
  res.json(CUSTOMS_OFFICES);
});

// Multer-ошибки → 400 с JSON.
router.use((err, _req, res, _next) => {
  if (err) return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
});

module.exports = router;
