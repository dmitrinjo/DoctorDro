const { Router } = require('express');
const pool = require('../db');

const router = Router();

// GET /api/comments?entity_type=error&entity_id=1
router.get('/', async (req, res) => {
  try {
    const { entity_type, entity_id, limit, order } = req.query;
    const conditions = [`patient_id = $1`];
    const params = [req.patientId];
    let i = 2;

    if (entity_type) {
      conditions.push(`entity_type = $${i++}`);
      params.push(entity_type);
    }
    if (entity_id) {
      conditions.push(`entity_id = $${i++}`);
      params.push(entity_id);
    }

    const direction = String(order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    let query = 'SELECT * FROM comments WHERE ' + conditions.join(' AND ') + ` ORDER BY created_at ${direction}`;

    const parsedLimit = parseInt(limit, 10);
    if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
      query += ` LIMIT ${parsedLimit}`;
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/comments
router.post('/', async (req, res) => {
  try {
    const { entity_type, entity_id, text, author } = req.body;
    if (!entity_type || entity_id == null || !text) {
      return res.status(400).json({ error: 'entity_type, entity_id, text required' });
    }
    // author опционально: 'user' (default) или 'ai' — для AI-координатора
    const authorValue = author === 'ai' ? 'ai' : 'user';
    const { rows } = await pool.query(
      'INSERT INTO comments (entity_type, entity_id, text, author, patient_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [entity_type, entity_id, text, authorValue, req.patientId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating comment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/comments/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM comments WHERE id = $1 AND patient_id = $2', [req.params.id, req.patientId]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    res.json({ message: 'Comment deleted' });
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
