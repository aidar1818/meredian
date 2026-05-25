// Админская отчётность: /api/reports/operators | clients | customs.
// Все агрегации по выбранному периоду — фильтр по `trucks.created_at` (от,до].
const express = require('express');
const { db } = require('../db');
const { requirePage } = require('../middleware/auth');

const router = express.Router();
const guard = requirePage('admin');

// ============================================================
// helpers
// ============================================================
function parseRange(req) {
  // from/to — миллисекунды UTC. По умолчанию: текущий месяц.
  const now = new Date();
  const defaultFrom = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const defaultTo   = Date.now();
  const from = Number(req.query.from) > 0 ? Number(req.query.from) : defaultFrom;
  const to   = Number(req.query.to)   > 0 ? Number(req.query.to)   : defaultTo;
  return { from, to };
}

function emptyMetrics() {
  return {
    totalCreated: 0,
    totalReleased: 0,
    totalInProgress: 0,
    totalProblems: 0,         // заявки с активной проблемой
    sumWeight: 0,
    sumGoods: 0,
    sumAmount: 0,
    avgCycleHours: null,      // среднее (released_at - created_at) среди isReleased
    customsBreakdown: {},     // { 'Кант': N, ... }
    operatorsBreakdown: {},   // { login: N, ... }
    clientsBreakdown: {},     // { 'ОсОО ...': N, ... }
  };
}

function bumpBreak(obj, key) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + 1;
}

function finalizeBreakdowns(m) {
  // Преобразуем словари в отсортированные массивы [{name, count}]
  const toArr = (obj) => Object.entries(obj)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  m.customsBreakdown   = toArr(m.customsBreakdown);
  m.operatorsBreakdown = toArr(m.operatorsBreakdown);
  m.clientsBreakdown   = toArr(m.clientsBreakdown);
  return m;
}

// Загружает заявки в периоде с join'ом логина оператора (если есть).
function fetchTrucks(from, to) {
  return db.prepare(`
    SELECT
      t.id, t.client, t.customs, t.created_at, t.released_at, t.is_released,
      t.goods_count, t.weight, t.sum_amount, t.assigned_operator_id, t.current_stage_index,
      u.login AS operator_login
    FROM trucks t
    LEFT JOIN users u ON u.id = t.assigned_operator_id
    WHERE t.created_at >= ? AND t.created_at < ?
    ORDER BY t.created_at DESC
  `).all(from, to);
}

function hasActiveProblemSql(truckId, stageIndex) {
  const row = db.prepare(
    `SELECT 1 FROM problems WHERE truck_id = ? AND stage_index = ? AND resolved_at IS NULL LIMIT 1`
  ).get(truckId, stageIndex);
  return !!row;
}

function accumulate(target, t) {
  target.totalCreated += 1;
  if (t.is_released) target.totalReleased += 1;
  else               target.totalInProgress += 1;
  if (!t.is_released && hasActiveProblemSql(t.id, t.current_stage_index)) target.totalProblems += 1;
  if (t.weight       != null) target.sumWeight += Number(t.weight) || 0;
  if (t.goods_count  != null) target.sumGoods  += Number(t.goods_count) || 0;
  if (t.sum_amount   != null) target.sumAmount += Number(t.sum_amount) || 0;
  bumpBreak(target.customsBreakdown,   t.customs);
  bumpBreak(target.operatorsBreakdown, t.operator_login || '— не назначен —');
  bumpBreak(target.clientsBreakdown,   t.client || '— не указан —');
  // Накопление длительностей для среднего цикла
  if (t.is_released && t.released_at && t.created_at) {
    target._cycleSum  = (target._cycleSum  || 0) + (t.released_at - t.created_at);
    target._cycleN    = (target._cycleN    || 0) + 1;
  }
}

function finalize(m) {
  if (m._cycleN) m.avgCycleHours = +(m._cycleSum / m._cycleN / 3_600_000).toFixed(2);
  delete m._cycleSum; delete m._cycleN;
  return finalizeBreakdowns(m);
}

// ============================================================
// ОПЕРАТОРЫ: группировка по assigned_operator_id
// ============================================================
router.get('/reports/operators', guard, (req, res) => {
  const { from, to } = parseRange(req);
  const trucks = fetchTrucks(from, to);

  // Группа «— не назначен —» отдельной строкой, чтобы было видно сколько висит без ответственного
  const groups = new Map(); // key = operator_login || '— не назначен —'
  for (const t of trucks) {
    const key = t.operator_login || '— не назначен —';
    if (!groups.has(key)) groups.set(key, { operatorLogin: key, ...emptyMetrics() });
    accumulate(groups.get(key), t);
  }

  // Все активные операторы — чтобы показывать даже тех, у кого 0 заявок
  const allOps = db.prepare(`
    SELECT u.login FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.status = 'ACTIVE' AND (r.pages LIKE '%"operator"%' OR r.pages LIKE '%"admin"%')
  `).all();
  for (const op of allOps) {
    if (!groups.has(op.login)) groups.set(op.login, { operatorLogin: op.login, ...emptyMetrics() });
  }

  const items = Array.from(groups.values()).map(finalize)
    .sort((a, b) => b.totalReleased - a.totalReleased || b.totalCreated - a.totalCreated);
  res.json({ from, to, items });
});

// ============================================================
// КЛИЕНТЫ: группировка по client
// ============================================================
router.get('/reports/clients', guard, (req, res) => {
  const { from, to } = parseRange(req);
  const trucks = fetchTrucks(from, to);

  const groups = new Map();
  for (const t of trucks) {
    const key = t.client || '— не указан —';
    if (!groups.has(key)) groups.set(key, { client: key, ...emptyMetrics() });
    accumulate(groups.get(key), t);
  }
  const items = Array.from(groups.values()).map(finalize)
    .sort((a, b) => b.totalCreated - a.totalCreated);
  res.json({ from, to, items });
});

// ============================================================
// ТАМОЖНИ: группировка по customs
// ============================================================
router.get('/reports/customs', guard, (req, res) => {
  const { from, to } = parseRange(req);
  const trucks = fetchTrucks(from, to);

  const groups = new Map();
  for (const t of trucks) {
    const key = t.customs;
    if (!groups.has(key)) groups.set(key, { customs: key, ...emptyMetrics() });
    accumulate(groups.get(key), t);
  }
  // Даже если у таможни 0 — покажем (для полноты картины)
  for (const c of ['Кара-Булак', 'Кант', 'Балыкчы', 'Манас']) {
    if (!groups.has(c)) groups.set(c, { customs: c, ...emptyMetrics() });
  }
  const items = Array.from(groups.values()).map(finalize)
    .sort((a, b) => b.totalCreated - a.totalCreated);
  res.json({ from, to, items });
});

// Сводный «глобальный» tile — для шапки страницы отчётов (общий KPI).
router.get('/reports/summary', guard, (req, res) => {
  const { from, to } = parseRange(req);
  const trucks = fetchTrucks(from, to);
  const summary = emptyMetrics();
  for (const t of trucks) accumulate(summary, t);
  finalize(summary);
  // Не нужны нам breakdowns в summary — отдадим основные числа
  res.json({
    from, to,
    totalCreated:    summary.totalCreated,
    totalReleased:   summary.totalReleased,
    totalInProgress: summary.totalInProgress,
    totalProblems:   summary.totalProblems,
    sumWeight:       summary.sumWeight,
    sumGoods:        summary.sumGoods,
    sumAmount:       summary.sumAmount,
    avgCycleHours:   summary.avgCycleHours,
  });
});

// ============================================================
// ДЕТАЛИЗАЦИЯ: список заявок для конкретного оператора / клиента / таможни
// GET /api/reports/trucks?from&to&kind=operator|client|customs&value=...
// Для значения «— не назначен / не указан —» передавать value=__none__
// ============================================================
router.get('/reports/trucks', guard, (req, res) => {
  const { from, to } = parseRange(req);
  const { kind, value } = req.query;

  let where = 't.created_at >= ? AND t.created_at < ?';
  const params = [from, to];

  if (kind === 'operator') {
    if (value === '__none__') {
      where += ' AND t.assigned_operator_id IS NULL';
    } else {
      where += ' AND u.login = ?';
      params.push(value);
    }
  } else if (kind === 'client') {
    if (value === '__none__') {
      where += " AND (t.client IS NULL OR t.client = '')";
    } else {
      where += ' AND t.client = ?';
      params.push(value);
    }
  } else if (kind === 'customs') {
    where += ' AND t.customs = ?';
    params.push(value);
  } else {
    return res.status(400).json({ error: 'Неизвестный kind' });
  }

  const rows = db.prepare(`
    SELECT t.id, t.number, t.client, t.customs, t.created_at, t.released_at,
           t.current_stage_index, t.is_released, t.goods_count, t.weight, t.sum_amount,
           t.assigned_operator_id, u.login AS operator_login
    FROM trucks t
    LEFT JOIN users u ON u.id = t.assigned_operator_id
    WHERE ${where}
    ORDER BY (t.is_released) ASC, t.created_at DESC
  `).all(...params);

  // Активные проблемы — одним запросом по всем нужным заявкам
  const ids = rows.map(r => r.id);
  let activeProblemsByTruck = new Map();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const probs = db.prepare(`
      SELECT p.truck_id, COUNT(*) AS active_count
      FROM problems p
      JOIN trucks t ON t.id = p.truck_id
      WHERE p.truck_id IN (${placeholders})
        AND p.resolved_at IS NULL
        AND p.stage_index = t.current_stage_index
        AND t.is_released = 0
      GROUP BY p.truck_id
    `).all(...ids);
    for (const p of probs) activeProblemsByTruck.set(p.truck_id, p.active_count);
  }

  const items = rows.map(r => ({
    id: r.id,
    number: r.number,
    client: r.client,
    customs: r.customs,
    createdAt: r.created_at,
    releasedAt: r.released_at,
    currentStageIndex: r.current_stage_index,
    isReleased: !!r.is_released,
    goodsCount: r.goods_count,
    weight: r.weight,
    sumAmount: r.sum_amount,
    assignedOperatorLogin: r.operator_login,
    hasActiveProblem: (activeProblemsByTruck.get(r.id) || 0) > 0,
    cycleHours: (r.is_released && r.released_at && r.created_at)
      ? +((r.released_at - r.created_at) / 3_600_000).toFixed(2)
      : null,
  }));

  res.json({ from, to, kind, value, items });
});

module.exports = router;
