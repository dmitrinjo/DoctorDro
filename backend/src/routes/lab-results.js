const { Router } = require('express');
const pool = require('../db');
const { validate, required, isIn } = require('../middleware/validate');

const router = Router();

// GET /api/lab-results
router.get('/', async (req, res) => {
  try {
    const { group_by } = req.query;

    if (group_by === 'parameter') {
      const { rows } = await pool.query('SELECT * FROM lab_results WHERE patient_id = $1 ORDER BY parameter ASC, test_date DESC', [req.patientId]);
      // Group by parameter name
      const grouped = {};
      for (const row of rows) {
        if (!grouped[row.parameter]) grouped[row.parameter] = [];
        grouped[row.parameter].push(row);
      }
      return res.json(grouped);
    }

    const { rows } = await pool.query('SELECT * FROM lab_results WHERE patient_id = $1 ORDER BY test_date DESC, parameter ASC', [req.patientId]);
    res.json(rows);
  } catch (err) {
    console.error('Ошибка получения анализов:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/lab-results/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM lab_results WHERE id = $1 AND patient_id = $2', [req.params.id, req.patientId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Результат не найден' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Ошибка получения результата:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// POST /api/lab-results
router.post('/',
  validate(
    required('test_date'),
    required('test_name'),
    required('parameter'),
    isIn('status', ['normal', 'low', 'high', 'critical'])
  ),
  async (req, res) => {
    try {
      const { test_date, test_name, parameter, value, unit, ref_min, ref_max, status, timeline_id, specialist_id, notes } = req.body;
      const { rows } = await pool.query(
        `INSERT INTO lab_results (test_date, test_name, parameter, value, unit, ref_min, ref_max, status, timeline_id, specialist_id, notes, patient_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [test_date, test_name, parameter, value, unit, ref_min, ref_max, status || 'normal', timeline_id, specialist_id || null, notes, req.patientId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error('Ошибка создания результата:', err);
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

// PUT /api/lab-results/:id
router.put('/:id', async (req, res) => {
  try {
    const { test_date, test_name, parameter, value, unit, ref_min, ref_max, status, timeline_id, specialist_id, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE lab_results
       SET test_date = $1, test_name = $2, parameter = $3, value = $4, unit = $5,
           ref_min = $6, ref_max = $7, status = $8, timeline_id = $9,
           specialist_id = $10, notes = $11
       WHERE id = $12 AND patient_id = $13
       RETURNING *`,
      [test_date, test_name, parameter, value, unit, ref_min, ref_max, status, timeline_id, specialist_id || null, notes, req.params.id, req.patientId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Результат не найден' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Ошибка обновления результата:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// DELETE /api/lab-results/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM lab_results WHERE id = $1 AND patient_id = $2', [req.params.id, req.patientId]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Результат не найден' });
    }
    res.json({ message: 'Результат удалён' });
  } catch (err) {
    console.error('Ошибка удаления результата:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
