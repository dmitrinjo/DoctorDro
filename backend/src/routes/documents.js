const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');
const config = require('../config');

const { convertPdfToImages, getPreviewUrls } = require('../services/pdf-preview');

const router = Router();

// Allowed MIME types — строгий whitelist.
// НЕ включаем image/svg+xml: SVG это XML который может содержать <script>
// и выполняется когда открывается в браузере → XSS в контексте
// нашего домена → кража localStorage со всей медкартой.
const ALLOWED_MIMES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
];

// Разрешённые расширения — вторая линия защиты.
// MIME тип в запросе отправляет клиент и его можно подделать, поэтому
// дополнительно проверяем расширение оригинального имени файла.
const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
]);

// Multer config with security limits
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
    cb(null, config.UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    // Нормализуем расширение в lowercase, берём только известные
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.bin';
    cb(null, `${uuidv4()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
    files: 1,                   // один файл за запрос
    fields: 20,                 // разумный лимит полей
  },
  fileFilter: (_req, file, cb) => {
    // Двойная проверка: mime type И расширение должны быть в whitelist
    const mimeOk = ALLOWED_MIMES.includes(file.mimetype);
    const ext = path.extname(file.originalname).toLowerCase();
    const extOk = ALLOWED_EXTENSIONS.has(ext);
    if (mimeOk && extOk) {
      cb(null, true);
    } else {
      cb(new Error(`Недопустимый тип файла: mime=${file.mimetype}, ext=${ext}`), false);
    }
  },
});

// Path traversal protection
function isPathSafe(filePath) {
  const resolved = path.resolve(filePath);
  const uploadDir = path.resolve(config.UPLOAD_DIR);
  return resolved.startsWith(uploadDir);
}

// GET /api/documents
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM documents WHERE patient_id = $1 ORDER BY created_at DESC', [req.patientId]);
    res.json(rows);
  } catch (err) {
    console.error('Ошибка получения документов:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/documents/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1 AND patient_id = $2', [req.params.id, req.patientId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Документ не найден' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Ошибка получения документа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/documents/:id/previews — PDF page previews as images
router.get('/:id/previews', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1 AND patient_id = $2', [req.params.id, req.patientId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Документ не найден' });
    }
    const doc = rows[0];
    const urls = getPreviewUrls(doc);
    res.json({ previews: urls });
  } catch (err) {
    console.error('Ошибка получения превью:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/documents/:id/file — download file
router.get('/:id/file', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1 AND patient_id = $2', [req.params.id, req.patientId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Документ не найден' });
    }

    const doc = rows[0];
    const filePath = path.resolve(doc.file_path);

    // Path traversal check
    if (!isPathSafe(filePath)) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Файл не найден на диске' });
    }

    res.download(filePath, doc.original_name);
  } catch (err) {
    console.error('Ошибка скачивания файла:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// POST /api/documents — file upload
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не предоставлен' });
    }

    const { title, category, notes, timeline_id } = req.body;
    const { originalname, filename, size, mimetype, path: filePath } = req.file;

    const { rows } = await pool.query(
      `INSERT INTO documents (title, category, original_name, file_path, file_size, mime_type, notes, timeline_id, patient_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [title || originalname, category, originalname, filePath, size, mimetype, notes, timeline_id || null, req.patientId]
    );

    const doc = rows[0];

    // Auto-generate PDF preview images
    if (mimetype === 'application/pdf') {
      try {
        const previewPaths = convertPdfToImages(filePath);
        if (previewPaths.length > 0) {
          doc.preview_urls = previewPaths.map(p => `/uploads/previews/${path.basename(p)}`);
        }
      } catch (err) {
        console.error('PDF preview generation error:', err.message);
      }
    }

    res.status(201).json(doc);
  } catch (err) {
    console.error('Ошибка загрузки документа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// PUT /api/documents/:id
router.put('/:id', async (req, res) => {
  try {
    const { title, category, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE documents
       SET title = $1, category = $2, notes = $3, updated_at = NOW()
       WHERE id = $4 AND patient_id = $5
       RETURNING *`,
      [title, category, notes, req.params.id, req.patientId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Документ не найден' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Ошибка обновления документа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// DELETE /api/documents/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM documents WHERE id = $1 AND patient_id = $2 RETURNING file_path', [req.params.id, req.patientId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Документ не найден' });
    }

    const filePath = rows[0].file_path;
    if (filePath && isPathSafe(filePath) && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ message: 'Документ удалён' });
  } catch (err) {
    console.error('Ошибка удаления документа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
