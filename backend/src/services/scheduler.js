const cron = require('node-cron');
const pool = require('../db');
const { sendMessage } = require('./telegram');

const rawDb = require('../db').rawDb;

/**
 * Проверяет напоминания каждые 15 минут.
 * Если remind_at <= NOW() и status = 'pending', отправляет в Telegram и помечает как sent.
 */
function initScheduler() {
  // Каждые 15 минут: */15 * * * *
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= NOW()"
      );

      for (const reminder of rows) {
        const text = `🔔 <b>${reminder.title}</b>\n${reminder.message || ''}`;

        await sendMessage(text);

        await pool.query(
          "UPDATE reminders SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1",
          [reminder.id]
        );

        console.log(`[Scheduler] Напоминание #${reminder.id} отправлено`);
      }

      if (rows.length > 0) {
        console.log(`[Scheduler] Обработано напоминаний: ${rows.length}`);
      }
    } catch (err) {
      console.error('[Scheduler] Ошибка проверки напоминаний:', err);
    }
  });

  console.log('[Scheduler] Планировщик напоминаний запущен (каждые 15 мин)');

  // Ежедневно в 03:00: удалять просроченные challenge-токены из app_settings.
  // pending_challenge_* и webauthn_challenge_* хранят { expires: timestampMs }.
  cron.schedule('0 3 * * *', () => {
    try {
      const rows = rawDb.prepare(
        "SELECT key, value FROM app_settings WHERE key LIKE 'pending_challenge_%' OR key LIKE 'webauthn_challenge_%'"
      ).all();

      let deleted = 0;
      for (const row of rows) {
        try {
          const data = JSON.parse(row.value);
          if (!data.expires || data.expires < Date.now()) {
            rawDb.prepare('DELETE FROM app_settings WHERE key = ?').run(row.key);
            deleted++;
          }
        } catch {
          // Битый JSON — удаляем
          rawDb.prepare('DELETE FROM app_settings WHERE key = ?').run(row.key);
          deleted++;
        }
      }

      if (deleted > 0) {
        console.log(`[Scheduler] Удалено просроченных challenge-токенов: ${deleted}`);
      }
    } catch (err) {
      console.error('[Scheduler] Ошибка очистки challenge-токенов:', err);
    }
  });
}

module.exports = { initScheduler };
