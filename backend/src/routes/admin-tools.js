// Admin tools — операционные эндпоинты для AI-координатора (Claude).
//
// Эти эндпоинты нужны для того, чтобы Claude мог выполнять свою работу
// одной-двумя командами вместо десяти SELECT-ов через ssh+sqlite3.
// Все эндпоинты защищены ADMIN_TOKEN (adminAuthMiddleware наследуется
// из index.js при монтировании под /api/admin/tools).
//
// Список эндпоинтов:
//   GET  /api/admin/tools/integrity        — PRAGMA integrity + foreign_key_check
//   GET  /api/admin/tools/orphan-check     — что в БД без документного обоснования
//   GET  /api/admin/tools/impact?type&id   — что сломается если удалить сущность
//   POST /api/admin/tools/sql              — выполнить произвольный SQL (UTF-8 безопасно)
//   GET  /api/admin/tools/search?q=...     — FTS5 поиск по timeline+documents+comments
//   GET  /api/admin/tools/changelog        — последние N записей audit_log
//   POST /api/admin/tools/mark-reviewed    — отметить что Claude всё просмотрел сейчас
//   GET  /api/admin/tools/since-last-review — что изменилось с последнего прохода

const express = require('express');
const { Router } = express;
const { rawDb } = require('../db');
const backup = require('../services/backup');

const router = Router();

// ───────────────────────────────────────────────────────────
// GET /integrity — проверка целостности БД
// Возвращает: { integrity: 'ok'|issues[], foreign_key_violations: [...] }
// ───────────────────────────────────────────────────────────
router.get('/integrity', (req, res) => {
  try {
    const integrity = rawDb.pragma('integrity_check');
    const fkViolations = rawDb.pragma('foreign_key_check');
    const ftsValid = [];
    for (const tbl of ['timeline_fts', 'documents_fts', 'comments_fts']) {
      try {
        rawDb.prepare(`INSERT INTO ${tbl}(${tbl}) VALUES ('integrity-check')`).run();
        ftsValid.push({ table: tbl, ok: true });
      } catch (e) {
        ftsValid.push({ table: tbl, ok: false, error: e.message });
      }
    }
    res.json({
      integrity,
      foreign_key_violations: fkViolations,
      fts_status: ftsValid,
      wal_mode: rawDb.pragma('journal_mode', { simple: true }),
      foreign_keys_on: rawDb.pragma('foreign_keys', { simple: true }) === 1,
    });
  } catch (err) {
    console.error('integrity check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// GET /orphan-check — что в БД без документного обоснования
// Возвращает списки записей которые нужно проверить/исправить:
//   - prescriptions с несуществующими FK
//   - documents без привязки к timeline и без source_doctor
//   - medications без prescriptions
//   - timeline без документов и без транскрипции
//   - visits с документами от конфликтующих источников
// ───────────────────────────────────────────────────────────
router.get('/orphan-check', (req, res) => {
  try {
    const pid = req.patientId;

    // 1. Prescriptions со ссылкой на несуществующие сущности
    const deadFkPrescriptions = rawDb.prepare(`
      SELECT p.id, p.medication_id, p.diagnosis_id, p.specialist_id, p.timeline_id
      FROM prescriptions p
      LEFT JOIN medications m ON m.id = p.medication_id
      LEFT JOIN diagnoses d ON d.id = p.diagnosis_id
      LEFT JOIN specialists s ON s.id = p.specialist_id
      LEFT JOIN timeline t ON t.id = p.timeline_id
      WHERE p.patient_id = ?
        AND (
          (p.medication_id IS NOT NULL AND m.id IS NULL) OR
          (p.diagnosis_id IS NOT NULL AND d.id IS NULL) OR
          (p.specialist_id IS NOT NULL AND s.id IS NULL) OR
          (p.timeline_id IS NOT NULL AND t.id IS NULL)
        )
    `).all(pid);

    // 2. Documents без timeline и без source_doctor/source_org
    const orphanDocuments = rawDb.prepare(`
      SELECT id, title, file_path, created_at
      FROM documents
      WHERE patient_id = ?
        AND timeline_id IS NULL
        AND (source_doctor IS NULL OR source_doctor = '')
        AND (source_org IS NULL OR source_org = '')
      ORDER BY created_at DESC
    `).all(pid);

    // 3. Medications без prescriptions (справочная запись без единого назначения)
    const orphanMedications = rawDb.prepare(`
      SELECT m.id, m.name, m.status, m.created_at
      FROM medications m
      WHERE m.patient_id = ?
        AND NOT EXISTS (SELECT 1 FROM prescriptions p WHERE p.medication_id = m.id)
      ORDER BY m.created_at DESC
    `).all(pid);

    // 4. Timeline без документов и без транскрипции
    const emptyTimeline = rawDb.prepare(`
      SELECT t.id, t.event_date, t.title, t.category
      FROM timeline t
      WHERE t.patient_id = ?
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.timeline_id = t.id)
        AND (t.transcription IS NULL OR length(t.transcription) < 20)
      ORDER BY t.event_date DESC
    `).all(pid);

    // 5. Documents с quality != 'good'
    const flaggedDocuments = rawDb.prepare(`
      SELECT id, title, quality, timeline_id
      FROM documents
      WHERE patient_id = ? AND quality != 'good'
      ORDER BY created_at DESC
    `).all(pid);

    // 6. AI assessments без источников (ai_sources IS NULL но ai_assessment заполнен)
    const assessmentsWithoutSources = {};
    for (const table of ['timeline', 'documents', 'diagnoses', 'medications', 'plan', 'medical_errors']) {
      try {
        const rows = rawDb.prepare(`
          SELECT id,
                 substr(COALESCE(${table === 'medical_errors' || table === 'plan' || table === 'diagnoses' || table === 'medications' ? 'name' : 'title'}, title, 'без названия'), 1, 60) AS title
          FROM ${table}
          WHERE patient_id = ?
            AND ai_assessment IS NOT NULL
            AND length(ai_assessment) > 50
            AND (ai_sources IS NULL OR ai_sources = '')
        `).all(pid);
        if (rows.length) assessmentsWithoutSources[table] = rows;
      } catch (e) {
        // Таблицы с полем "name" а не "title" — упрощённый SELECT
        try {
          const rows = rawDb.prepare(`
            SELECT id FROM ${table}
            WHERE patient_id = ? AND ai_assessment IS NOT NULL AND length(ai_assessment) > 50
              AND (ai_sources IS NULL OR ai_sources = '')
          `).all(pid);
          if (rows.length) assessmentsWithoutSources[table] = rows;
        } catch (e2) {}
      }
    }

    // 7. Duplicate documents by hash
    const duplicateHashes = rawDb.prepare(`
      SELECT file_hash, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
      FROM documents
      WHERE patient_id = ? AND file_hash IS NOT NULL
      GROUP BY file_hash
      HAVING cnt > 1
    `).all(pid);

    const summary = {
      dead_fk_prescriptions: deadFkPrescriptions.length,
      orphan_documents: orphanDocuments.length,
      orphan_medications: orphanMedications.length,
      empty_timeline: emptyTimeline.length,
      flagged_documents: flaggedDocuments.length,
      assessments_without_sources: Object.values(assessmentsWithoutSources).reduce((a, b) => a + b.length, 0),
      duplicate_hashes: duplicateHashes.length,
    };

    res.json({
      summary,
      dead_fk_prescriptions: deadFkPrescriptions,
      orphan_documents: orphanDocuments,
      orphan_medications: orphanMedications,
      empty_timeline: emptyTimeline,
      flagged_documents: flaggedDocuments,
      assessments_without_sources: assessmentsWithoutSources,
      duplicate_hashes: duplicateHashes,
      clean: Object.values(summary).every(v => v === 0),
    });
  } catch (err) {
    console.error('orphan-check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// GET /impact?type=medication&id=N — dry-run для удаления
// Показывает все сущности которые будут затронуты при удалении.
// Поддерживаемые типы: medication, timeline, document, diagnosis,
// specialist, plan, error.
// ───────────────────────────────────────────────────────────
const IMPACT_QUERIES = {
  medication: (id, pid) => ({
    prescriptions: rawDb.prepare('SELECT id, timeline_id, specialist_id FROM prescriptions WHERE medication_id=? AND patient_id=?').all(id, pid),
  }),
  timeline: (id, pid) => ({
    documents_on_visit: rawDb.prepare('SELECT id, title FROM documents WHERE timeline_id=? AND patient_id=?').all(id, pid),
    prescriptions_on_visit: rawDb.prepare('SELECT id, medication_id FROM prescriptions WHERE timeline_id=? AND patient_id=?').all(id, pid),
    visit_diagnoses: rawDb.prepare('SELECT diagnosis_id, relation FROM visit_diagnoses WHERE visit_id=? AND patient_id=?').all(id, pid),
    lab_results_linked: rawDb.prepare('SELECT id, parameter FROM lab_results WHERE timeline_id=? AND patient_id=?').all(id, pid),
    comments: rawDb.prepare("SELECT id, substr(text,1,60) AS preview FROM comments WHERE entity_type='timeline' AND entity_id=? AND patient_id=?").all(id, pid),
  }),
  document: (id, pid) => ({
    children_by_parent: rawDb.prepare('SELECT id, title FROM documents WHERE parent_document_id=? AND patient_id=?').all(id, pid),
    comments: rawDb.prepare("SELECT id, substr(text,1,60) AS preview FROM comments WHERE entity_type='document' AND entity_id=? AND patient_id=?").all(id, pid),
    file_path: rawDb.prepare('SELECT file_path FROM documents WHERE id=? AND patient_id=?').get(id, pid)?.file_path || null,
  }),
  diagnosis: (id, pid) => ({
    prescriptions: rawDb.prepare('SELECT id FROM prescriptions WHERE diagnosis_id=? AND patient_id=?').all(id, pid),
    visit_diagnoses: rawDb.prepare('SELECT visit_id FROM visit_diagnoses WHERE diagnosis_id=? AND patient_id=?').all(id, pid),
    comments: rawDb.prepare("SELECT id, substr(text,1,60) AS preview FROM comments WHERE entity_type='diagnosis' AND entity_id=? AND patient_id=?").all(id, pid),
  }),
  specialist: (id, pid) => ({
    timeline_visits: rawDb.prepare('SELECT id, title, event_date FROM timeline WHERE specialist_id=? AND patient_id=?').all(id, pid),
    medications: rawDb.prepare('SELECT id, name FROM medications WHERE specialist_id=? AND patient_id=?').all(id, pid),
    prescriptions: rawDb.prepare('SELECT id FROM prescriptions WHERE specialist_id=? AND patient_id=?').all(id, pid),
    lab_results: rawDb.prepare('SELECT id, test_name FROM lab_results WHERE specialist_id=? AND patient_id=?').all(id, pid),
    medical_errors: rawDb.prepare('SELECT id, title FROM medical_errors WHERE specialist_id=? AND patient_id=?').all(id, pid),
  }),
  plan: (id, pid) => ({
    comments: rawDb.prepare("SELECT id, substr(text,1,60) AS preview FROM comments WHERE entity_type='plan' AND entity_id=? AND patient_id=?").all(id, pid),
  }),
  error: (id, pid) => ({
    comments: rawDb.prepare("SELECT id, substr(text,1,60) AS preview FROM comments WHERE entity_type='error' AND entity_id=? AND patient_id=?").all(id, pid),
  }),
};

router.get('/impact', (req, res) => {
  try {
    const { type, id } = req.query;
    const pid = req.patientId;
    if (!type || !id || !IMPACT_QUERIES[type]) {
      return res.status(400).json({
        error: 'Usage: ?type=medication|timeline|document|diagnosis|specialist|plan|error&id=N',
      });
    }
    const data = IMPACT_QUERIES[type](parseInt(id, 10), pid);
    const totalAffected = Object.values(data).reduce(
      (sum, v) => sum + (Array.isArray(v) ? v.length : 0),
      0
    );
    res.json({ type, id: parseInt(id, 10), total_affected: totalAffected, details: data });
  } catch (err) {
    console.error('impact error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// POST /sql — выполнить произвольный SQL (для Claude)
// Body: { sql: "...", params?: [...], dry_run?: bool }
// Безопасно для UTF-8 (идёт как application/json).
// Возвращает: { rows?: [...], changes?: N, last_insert_rowid?: N }
// В dry_run режиме оборачивает в транзакцию и откатывает.
// ───────────────────────────────────────────────────────────
router.post('/sql', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { sql, params = [], dry_run = false } = req.body;
    if (!sql || typeof sql !== 'string') {
      return res.status(400).json({ error: 'sql required' });
    }
    // Блокируем совсем опасные команды
    const forbidden = /\b(PRAGMA\s+writable_schema|ATTACH|DETACH|LOAD_EXTENSION)\b/i;
    if (forbidden.test(sql)) {
      return res.status(403).json({ error: 'forbidden SQL pattern' });
    }

    const trimmed = sql.trim().toUpperCase();
    const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('EXPLAIN');

    if (isSelect) {
      const rows = rawDb.prepare(sql).all(...(Array.isArray(params) ? params : []));
      return res.json({ rows, count: rows.length });
    }

    // Write operations — wrap in transaction
    if (dry_run) {
      const tx = rawDb.transaction(() => {
        const info = rawDb.prepare(sql).run(...(Array.isArray(params) ? params : []));
        throw new Error('__DRY_RUN_ROLLBACK__:' + JSON.stringify({
          changes: info.changes,
          last_insert_rowid: Number(info.lastInsertRowid),
        }));
      });
      try { tx(); } catch (e) {
        if (String(e.message).startsWith('__DRY_RUN_ROLLBACK__:')) {
          const payload = JSON.parse(e.message.slice('__DRY_RUN_ROLLBACK__:'.length));
          return res.json({ dry_run: true, ...payload });
        }
        throw e;
      }
      return;
    }

    const info = rawDb.prepare(sql).run(...(Array.isArray(params) ? params : []));
    res.json({
      changes: info.changes,
      last_insert_rowid: Number(info.lastInsertRowid),
    });
  } catch (err) {
    console.error('sql exec error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// GET /search?q=... — унифицированный FTS5 поиск
// Ищет одновременно по timeline, documents, comments.
// Возвращает объединённые результаты с highlight-сниппетами.
// ───────────────────────────────────────────────────────────
router.get('/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
    if (!q) return res.status(400).json({ error: 'q parameter required' });

    // Экранируем кавычки в запросе для FTS5
    const ftsQuery = q.replace(/"/g, '""');

    // Timeline (через JOIN по rowid=id)
    const timelineHits = rawDb.prepare(`
      SELECT t.id, t.event_date, t.title, t.specialist_name, t.category,
             snippet(timeline_fts, 2, '<mark>', '</mark>', '…', 20) AS snippet,
             rank
      FROM timeline_fts
      JOIN timeline t ON t.id = timeline_fts.rowid
      WHERE timeline_fts MATCH ? AND t.patient_id = ?
      ORDER BY rank LIMIT ?
    `).all(ftsQuery, req.patientId, limit);

    // Documents
    const documentHits = rawDb.prepare(`
      SELECT d.id, d.timeline_id, d.title, d.source_doctor, d.source_org,
             snippet(documents_fts, 1, '<mark>', '</mark>', '…', 20) AS snippet,
             rank
      FROM documents_fts
      JOIN documents d ON d.id = documents_fts.rowid
      WHERE documents_fts MATCH ? AND d.patient_id = ?
      ORDER BY rank LIMIT ?
    `).all(ftsQuery, req.patientId, limit);

    // Comments
    const commentHits = rawDb.prepare(`
      SELECT c.id, c.entity_type, c.entity_id, c.created_at,
             snippet(comments_fts, 0, '<mark>', '</mark>', '…', 20) AS snippet,
             rank
      FROM comments_fts
      JOIN comments c ON c.id = comments_fts.rowid
      WHERE comments_fts MATCH ? AND c.patient_id = ?
      ORDER BY rank LIMIT ?
    `).all(ftsQuery, req.patientId, limit);

    res.json({
      query: q,
      total: timelineHits.length + documentHits.length + commentHits.length,
      timeline: timelineHits,
      documents: documentHits,
      comments: commentHits,
    });
  } catch (err) {
    console.error('search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// GET /changelog?limit=50&since=... — последние записи audit_log
// Показывает реальную историю изменений из триггеров.
// ───────────────────────────────────────────────────────────
router.get('/changelog', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const since = req.query.since || null;
    let rows;
    if (since) {
      rows = rawDb.prepare(`
        SELECT id, entity_type, entity_id, action, old_value, new_value, created_at
        FROM audit_log
        WHERE created_at > ?
        ORDER BY id DESC LIMIT ?
      `).all(since, limit);
    } else {
      rows = rawDb.prepare(`
        SELECT id, entity_type, entity_id, action, old_value, new_value, created_at
        FROM audit_log
        ORDER BY id DESC LIMIT ?
      `).all(limit);
    }
    res.json({ count: rows.length, entries: rows });
  } catch (err) {
    console.error('changelog error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// POST /mark-reviewed — Claude отмечает что всё просмотрел
// Обновляет last_ai_review_at_{pid} в app_settings на datetime('now').
// ───────────────────────────────────────────────────────────
router.post('/mark-reviewed', (req, res) => {
  try {
    const pid = req.patientId;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    rawDb.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)"
    ).run(`last_ai_review_at_${pid}`, now);
    res.json({ ok: true, patient_id: pid, marked_at: now });
  } catch (err) {
    console.error('mark-reviewed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// GET /since-last-review — что изменилось/добавилось с последнего прохода
// Возвращает все записи с updated_at > last_ai_review_at.
// ───────────────────────────────────────────────────────────
router.get('/since-last-review', (req, res) => {
  try {
    const pid = req.patientId;
    const setting = rawDb.prepare(
      "SELECT value FROM app_settings WHERE key = ?"
    ).get(`last_ai_review_at_${pid}`);
    const since = setting?.value || '1970-01-01 00:00:00';

    const result = {
      since,
      timeline: rawDb.prepare(
        'SELECT id, event_date, title, created_at, updated_at FROM timeline WHERE patient_id=? AND (created_at > ? OR updated_at > ?) ORDER BY updated_at DESC'
      ).all(pid, since, since),
      documents: rawDb.prepare(
        'SELECT id, title, timeline_id, created_at, updated_at FROM documents WHERE patient_id=? AND (created_at > ? OR updated_at > ?) ORDER BY updated_at DESC'
      ).all(pid, since, since),
      comments: rawDb.prepare(
        'SELECT id, entity_type, entity_id, substr(text,1,100) AS preview, created_at FROM comments WHERE patient_id=? AND created_at > ? ORDER BY created_at DESC'
      ).all(pid, since),
      ai_requests: rawDb.prepare(
        "SELECT id, entity_type, entity_id, status, created_at FROM ai_requests WHERE patient_id=? AND status='pending' AND created_at > ? ORDER BY created_at DESC"
      ).all(pid, since),
      lab_results: rawDb.prepare(
        'SELECT id, test_date, test_name, parameter, value, status, created_at FROM lab_results WHERE patient_id=? AND created_at > ? ORDER BY created_at DESC'
      ).all(pid, since),
      audit_events: rawDb.prepare(
        'SELECT id, entity_type, entity_id, action, created_at FROM audit_log WHERE created_at > ? ORDER BY id DESC LIMIT 200'
      ).all(since),
    };
    result.summary = {
      timeline: result.timeline.length,
      documents: result.documents.length,
      comments: result.comments.length,
      pending_ai_requests: result.ai_requests.length,
      lab_results: result.lab_results.length,
      audit_events: result.audit_events.length,
    };
    result.empty = Object.values(result.summary).every(v => v === 0);
    res.json(result);
  } catch (err) {
    console.error('since-last-review error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// GET /ai-review — «всё что нужно Claude перед началом работы»
// Объединяет integrity + orphan-check + since-last-review в один вызов.
// ───────────────────────────────────────────────────────────
router.get('/ai-review', async (req, res) => {
  try {
    // Переиспользуем логику через прямой вызов
    const pid = req.patientId;

    // Integrity
    const integrity = rawDb.pragma('integrity_check');
    const fkViolations = rawDb.pragma('foreign_key_check');

    // Pending AI requests
    const pendingAi = rawDb.prepare(
      "SELECT id, entity_type, entity_id, created_at FROM ai_requests WHERE patient_id=? AND status='pending' ORDER BY created_at ASC"
    ).all(pid);

    // Last review marker
    const setting = rawDb.prepare(
      "SELECT value FROM app_settings WHERE key = ?"
    ).get(`last_ai_review_at_${pid}`);
    const lastReviewAt = setting?.value || '1970-01-01 00:00:00';

    // Orphan summary (краткая сводка)
    const orphanCounts = {
      prescriptions_with_dead_fk: rawDb.prepare(`
        SELECT COUNT(*) AS c FROM prescriptions p
        LEFT JOIN medications m ON m.id=p.medication_id
        WHERE p.patient_id=? AND p.medication_id IS NOT NULL AND m.id IS NULL
      `).get(pid).c,
      medications_without_prescription: rawDb.prepare(`
        SELECT COUNT(*) AS c FROM medications m
        WHERE m.patient_id=? AND NOT EXISTS(SELECT 1 FROM prescriptions p WHERE p.medication_id=m.id)
      `).get(pid).c,
      documents_flagged: rawDb.prepare(
        "SELECT COUNT(*) AS c FROM documents WHERE patient_id=? AND quality != 'good'"
      ).get(pid).c,
    };

    // Новое с последнего review
    const newSinceReview = {
      timeline: rawDb.prepare(
        'SELECT COUNT(*) AS c FROM timeline WHERE patient_id=? AND (created_at > ? OR updated_at > ?)'
      ).get(pid, lastReviewAt, lastReviewAt).c,
      documents: rawDb.prepare(
        'SELECT COUNT(*) AS c FROM documents WHERE patient_id=? AND (created_at > ? OR updated_at > ?)'
      ).get(pid, lastReviewAt, lastReviewAt).c,
      comments: rawDb.prepare(
        'SELECT COUNT(*) AS c FROM comments WHERE patient_id=? AND created_at > ?'
      ).get(pid, lastReviewAt).c,
    };

    res.json({
      patient_id: pid,
      last_review_at: lastReviewAt,
      integrity_ok: integrity.length === 1 && integrity[0].integrity_check === 'ok',
      integrity_details: integrity,
      fk_violations: fkViolations,
      pending_ai_requests: pendingAi,
      orphan_counts: orphanCounts,
      new_since_review: newSinceReview,
      ready_to_work: fkViolations.length === 0 && integrity.length === 1 && integrity[0].integrity_check === 'ok',
    });
  } catch (err) {
    console.error('ai-review error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// POST /backup-now — триггернуть бэкап вручную
// Делает и hot snapshot, и daily archive (с шифрованием +
// отправкой в Telegram если настроено). Ответ — статус и пути.
// ───────────────────────────────────────────────────────────
router.post('/backup-now', async (req, res) => {
  try {
    const result = await backup.createBackupNow();
    res.json({
      ok: !!result.hot,
      hot_backup: result.hot ? require('path').basename(result.hot) : null,
      archive: result.archive || null,
    });
  } catch (err) {
    console.error('backup-now error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// GET /backups — список всех локальных бэкапов
// Показывает hot snapshots + daily archives, их размеры, даты.
// ───────────────────────────────────────────────────────────
router.get('/backups', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '..', '..', 'data', 'backups');
    const archiveDir = path.join(backupDir, 'archives');

    const hot = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir)
          .filter(f => f.endsWith('.db'))
          .map(f => {
            const full = path.join(backupDir, f);
            const stat = fs.statSync(full);
            return {
              name: f,
              size_kb: Math.round(stat.size / 1024),
              created_at: stat.mtime.toISOString(),
            };
          })
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
      : [];

    const archives = fs.existsSync(archiveDir)
      ? fs.readdirSync(archiveDir)
          .filter(f => f.endsWith('.tar.gz') || f.endsWith('.tar.gz.enc'))
          .map(f => {
            const full = path.join(archiveDir, f);
            const stat = fs.statSync(full);
            return {
              name: f,
              size_mb: (stat.size / 1024 / 1024).toFixed(2),
              encrypted: f.endsWith('.enc'),
              created_at: stat.mtime.toISOString(),
            };
          })
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
      : [];

    res.json({
      hot_backups: hot,
      daily_archives: archives,
      counts: { hot: hot.length, archives: archives.length },
    });
  } catch (err) {
    console.error('list backups error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
