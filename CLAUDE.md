# Anamnesis (DoctorDro) — Project Guide for Claude

> Читай этот файл в самом начале каждой новой сессии. Затем читай `ROADMAP.md`.

---

## Что это за проект

**Anamnesis** — самохостируемый AI-координируемый медицинский трекер для семьи.
Форк: https://github.com/Veta-one/anamnesis
Оригинальная статья: https://habr.com/ru/articles/1022450/

**Владелец**: пользователь без технических знаний — всё делает Claude сам.
**AI-координатор**: Claude Code (Claude Pro подписка). Прямые API-ключи Anthropic не нужны.
**Цель адаптации**: мультиязычность (RU/LV/EN), латвийский рынок, killer-фичи.

---

## Текущий статус проекта

| Что | Статус |
|---|---|
| Проект развёрнут локально | ✅ |
| Backend запущен | ✅ порт 3010 |
| Frontend запущен | ✅ порт 5173 |
| База данных создана | ✅ демо-пациент |
| Безопасность (gitignore) | ✅ ключи не утекут |
| ROADMAP.md создан | ✅ |
| M1.1 IDOR-баги (P0) исправлены | ✅ |
| M1.2 Важные баги (P1) исправлены | ✅ |
| Фронтенд security audit | ✅ `security-audit.md` |
| Демо-пациент заменён | ❌ **следующий шаг** |

**Ближайшее действие**: M1.3 — удалить dead code (4 файла/функции).
После — M2: заменить демо-пациента. Пользователь скажет: имя, дата рождения, пол.

---

## Как запустить (каждый раз)

```bash
# Терминал 1
cd backend && npm start

# Терминал 2
cd frontend && npm run dev
```

Открыть **http://localhost:5173** — PIN смотри в `backend/.env` (APP_PIN)

---

## Безопасность

Все секреты защищены `.gitignore` — ни ключи, ни база, ни документы не попадут в git.

| Файл/Папка | Защита |
|---|---|
| `backend/.env` | ✅ строка 5 |
| `backend/data/` (база) | ✅ строка 14 |
| `backend/uploads/` (документы) | ✅ |
| `*.log` | ✅ |

Токены (в `backend/.env`, никуда не копировать):
- `APP_PIN` — PIN входа в приложение
- `API_TOKEN` — для обычных запросов
- `ADMIN_TOKEN` — для `/api/admin/tools/*`

---

## Архитектура

### Паттерн: AI-координатор через HTTP API
Нет прямых вызовов LLM. Цикл работы:
1. Claude читает `AI_COORDINATOR_GUIDE.md` (50KB протокол — обязательно перед работой с данными)
2. `GET /api/patient-context` → полный снимок базы (~200-500KB JSON)
3. Анализирует, ищет противоречия, пропущенные обследования
4. Пишет результаты обратно через REST API
5. `ai_requests` таблица — очередь задач, поставленных через UI

### Когда появился новый документ
1. Пользователь загружает PDF через UI
2. (Опционально) нажимает "Запросить AI-анализ"
3. Говорит Claude: **"посмотри инструкцию, есть новый документ"**
4. Claude работает по протоколу из `AI_COORDINATOR_GUIDE.md`

### Правила при работе с данными
- Каждая запись в БД = документ-источник (ничего не выдумывать)
- Двухэтапная проверка PDF: 200 DPI → 400 DPI перед коммитом
- Всегда `author='ai'` при вставке в comments/ai_chat
- Backup (`sqlite3 … .backup`) перед любым крупным изменением

### База данных
- SQLite (WAL, foreign_keys=ON, FTS5)
- 40 audit triggers → `audit_log` (автоматическая история изменений)
- До 4 пациентов, изоляция по `patient_id`
- Миграции: `try { db.exec('ALTER TABLE ...') } catch(e) {}` в `db.js`

### Стек
- **Frontend**: React 19 + TypeScript strict + Vite 7 + TanStack Query 5 + React Router 7 + Motion + Cytoscape + PWA
- **Backend**: Node.js 22 + Express + better-sqlite3 + WebAuthn
- Модалки = child-routes (F5 сохраняет, Back закрывает)

---

## Ключевые файлы

| Файл | Назначение |
|---|---|
| `ROADMAP.md` | Полный план развития — читать после этого файла |
| `AI_COORDINATOR_GUIDE.md` | Протокол для Claude при работе с данными пациента |
| `backend/src/db.js` | Schema + migrations + 40 audit triggers |
| `backend/src/config.js` | Все env-переменные |
| `backend/src/routes/patient-context.js` | Главный endpoint для AI |
| `backend/src/routes/admin-tools.js` | Admin API (ai-review, integrity, sql, search) |
| `backend/src/services/backup.js` | 3-2-1 backup + Telegram |
| `backend/src/services/changelog.js` | audit_log → читаемые записи |
| `frontend/src/app/router.tsx` | Все роуты + модалки как child-routes |
| `DEPLOY.md` | Production deploy на VPS (Ubuntu + nginx + systemd) |

---

## Roadmap — краткая версия

Полный план в `ROADMAP.md`. Порядок milestone:

| # | Milestone | Статус |
|---|---|---|
| M0 | Фундамент (setup, gitignore, запуск) | ✅ Готово |
| M1 | Стабилизация (тесты, линтер) | 🔄 QA ✅, баги P0/P1 ✅, dead code + тесты ждут |
| M2 | Первый реальный пациент + бэкапы | 🔲 **следующий после M1** |
| M3 | i18n — RU / LV / EN | 🔲 |
| M4 | Латвийский рынок (personas kods, лаборатории) | 🔲 |
| M5 | AI-автоматизация (авто-цикл, Whisper, уведомления) | 🔲 |
| M6 | Killer Features (проверка препаратов, шкала здоровья) | 🔲 |
| M7 | Мобильное приложение (Capacitor) | 🔲 |
| M8 | Масштабирование (если нужно для других семей) | 🔲 |

---

## Конвенции кода

- Хирургические изменения — трогать только нужное
- Миграции только через try/catch ALTER TABLE в `db.js`
- Комментарии только там, где WHY не очевиден
- TypeScript strict — фронт; CommonJS — бэк
- Никаких эмодзи в полях БД
- Язык контента в БД = язык исходного документа

---

## Известные баги — исправить до релиза

> Подробный план: `refactoring-plan.md` (создан 14.05.2026).
> Ниже — только критические, остальное в файле.

### КРИТИЧЕСКИЕ (P0 — Security) — ИСПРАВЛЕНО ✅
- ~~**IDOR в `documents.js`**~~ — исправлено: `AND patient_id = ?` добавлен во все 5 запросов
- ~~**IDOR в `comments.js`**~~ — исправлено: `DELETE /:id` теперь с `patient_id`
- ~~**IDOR в `lab-results.js`**~~ — исправлено: GET/PUT/DELETE теперь с `patient_id`

### ВЫСОКИЙ ПРИОРИТЕТ (P1) — ИСПРАВЛЕНО ✅
- ~~`AuthContext.logout()` не вызывает `POST /api/auth/logout`~~ — исправлено
- ~~В UI нет кнопки «Выйти»~~ — добавлена в `MorePage.tsx`
- ~~Хардкод `"danil-"` в `admin-tools.js`~~ — исправлено

### DEAD CODE (удалить) — M1.3, ещё не сделано
- `backend/src/middleware/audit.js` — никем не импортируется
- `authMiddleware` в `index.js` — импортирован, но не применён
- `frontend/src/shared/hooks/useHaptic.ts` — нигде не вызывается
- `resetDeviceId()` в `session.ts` — нигде не вызывается

---

## История сессий

### Сессия 1 — 14.05.2026
- Изучил весь проект и PDF-статью автора
- Создал `CLAUDE.md`, `ROADMAP.md`
- Настроил окружение: `.env`, зависимости, БД
- Запустил проект, проверил в браузере
- Проверил безопасность (gitignore)
- Составил подробный ROADMAP с killer-фичами

### Сессия 2 — 14.05.2026
- Полный QA-аудит кода (статический, без запуска)
- Найдено 3 критических IDOR-уязвимости + 15 багов разного приоритета
- Найдено 4 единицы dead code
- Составлен список из 9 accessibility-проблем (WCAG 2.1)
- Создан `refactoring-plan.md` — полный план исправлений с приоритетами

### Сессия 3 — 14.05.2026
- Фронтенд security audit по OWASP Top 10 / ISO 27001 → создан `security-audit.md`
  (12 уязвимостей: 1 критическая CSP, 2 высоких, 3 средних, 4 низких)
- Убрана killer-фича QR-карточки из ROADMAP → перенесена в `IDEAS.md`
- Исправлены M1.1 (IDOR P0): 7 мест в documents.js, comments.js, lab-results.js
- Исправлены M1.2 (P1): logout на сервере, кнопка «Выйти» в MorePage, хардкод "danil-",
  очистка просроченных challenge-токенов в scheduler.js (cron 03:00)
