/**
 * Серверная телеметрия MatchWatch.
 *
 * Три независимых потока:
 *   1. Исключения кода      -> Sentry (структурированный контекст).
 *   2. Сбои логики (BIZ)    -> Sentry (warning) + журнал в Postgres.
 *      Именно то, что обычный error-трекер не ловит: «комната не найдена»,
 *      «TMDB вернул пусто», «политика доступа отклонила запись».
 *   3. Продуктовые метрики  -> таблица ops_metrics, поверх неё считает
 *      дашборд (SQL-агрегаты вместо ручных счётчиков).
 *
 * Плюс детектор всплесков: если критичных ошибок за час больше порога —
 * уходит алерт в Telegram-бот, а не ждём, пока пользователь напишет сам.
 */

import { createSentryTransport } from '../../shared/telemetry/sentryTransport.js';
import { ALERTABLE_LEVELS, LEVEL, resolveEnvironment } from '../../shared/telemetry/events.js';
import { hasServiceKey, sbInsert, sbSelect } from './supabaseAdmin.js';

const ENV = resolveEnvironment(process.env.MATCHWATCH_ENV);
const RELEASE = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? 'dev';

const sentry = createSentryTransport({
  dsn: process.env.SENTRY_DSN,
  environment: ENV,
  release: `matchwatch@${RELEASE}`,
  platform: 'node',
  serverName: process.env.VERCEL_REGION ?? 'local',
});

/**
 * Записи журнала, которые ещё не легли в базу.
 *
 * Serverless-функция живёт ровно до ответа: как только ответ отправлен,
 * платформа замораживает контейнер, и всё, чего никто не ждал, умирает
 * вместе с ним — незавершённый запрос к базе падает с «fetch failed».
 * Именно так журнал и терялся: эндпоинт отвечал `ok: true` за две
 * миллисекунды, а вставка не успевала уйти.
 *
 * Поэтому записи учитываются здесь, а обёртка запроса дожидается их
 * перед самым ответом.
 */
const pending = new Set();

/**
 * Потолок ожидания журнала перед ответом.
 *
 * Две секунды: вставка укладывается в десятки миллисекунд, так что
 * этот предел срабатывает только когда что-то действительно сломалось.
 */
const FLUSH_TIMEOUT_MS = 2000;

/** Журнал не имеет права ронять запрос. */
const safe = (promise) => {
  const tracked = promise
    .catch((error) => {
      console.warn('[telemetry] запись не удалась:', error?.message ?? error);
      return null;
    })
    .finally(() => pending.delete(tracked));

  pending.add(tracked);
  return tracked;
};

/**
 * Дождаться, пока журнал ляжет в базу.
 *
 * Цикл, а не один `Promise.all`: запись умеет порождать следующую —
 * ошибка проверяет всплеск и дописывает событие об алерте. За один
 * проход такая вторая волна осталась бы неучтённой.
 *
 * Ошибки сюда не долетают: их уже проглотил `safe`. Ждать журнал
 * безопасно — он не может провалить сам запрос.
 */
export async function flushTelemetry(timeoutMs = FLUSH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (pending.size && Date.now() < deadline) {
    /*
     * Ждём с потолком: у запроса к базе своего тайм-аута нет, и один
     * повисший на потерянном соединении вызов задержал бы ответ
     * пользователю ровно настолько, насколько ему хватит терпения.
     *
     * Гонка не отменяет саму запись — она лишь перестаёт её ждать.
     * В худшем случае мы теряем строку журнала, как теряли раньше;
     * в обычном — не теряем ничего. Терять ответ пользователю ради
     * строки в журнале нельзя ни в каком случае.
     */
    await Promise.race([
      Promise.all([...pending]),
      new Promise((resolve) => { setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
    ]);
  }
}

const isUuid = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Логирует исключение или явную ошибку со структурированным контекстом.
 * @param {object} p
 * @param {string} p.message
 * @param {string} p.module   один из MODULE
 * @param {string} [p.level]  critical | error | warning
 * @param {Error}  [p.error]
 * @param {string} [p.userId]
 * @param {string} [p.roomCode]
 * @param {object} [p.context]
 */
export function logError({ message, module: mod, level = LEVEL.ERROR, error, userId, roomCode, context = {} }) {
  const enriched = {
    ...context,
    ...(roomCode ? { room_code: roomCode } : {}),
    env: ENV,
    region: process.env.VERCEL_REGION ?? 'local',
  };

  console.error(`[${level}] ${mod} — ${message}`, error?.stack ?? '', enriched);

  sentry.capture({
    message, level, module: mod, error, context: enriched,
    tags: roomCode ? { room_code: roomCode } : {},
    user: userId ? { id: userId } : undefined,
  });

  if (!hasServiceKey()) return;

  safe(sbInsert('ops_events', {
    environment: ENV,
    kind: 'error',
    name: error?.name ?? 'Error',
    module: mod ?? 'unknown',
    level,
    user_id: isUuid(userId) ? userId : null,
    room_code: roomCode ?? null,
    message: String(message).slice(0, 2000),
    stack: error?.stack?.slice(0, 6000) ?? null,
    context: enriched,
  }));

  if (ALERTABLE_LEVELS.includes(level)) safe(checkForSpike({ level, module: mod, message }));
}

/**
 * Логирует сбой логики: код не упал, но задуманное не случилось.
 * @param {string} name  один из BIZ
 */
export function logBusinessEvent(name, { module: mod, userId, roomCode, level = LEVEL.WARNING, context = {} } = {}) {
  console.warn(`[biz] ${name} @ ${mod}`, context);

  sentry.capture({
    message: `business:${name}`,
    level,
    module: mod,
    context: { ...context, business_event: name, room_code: roomCode ?? undefined },
    tags: { business_event: name, ...(roomCode ? { room_code: roomCode } : {}) },
    user: userId ? { id: userId } : undefined,
    // Одинаковые сбои должны группироваться в одну проблему.
    fingerprint: ['business', name, mod ?? 'unknown'],
  });

  if (!hasServiceKey()) return null;

  safe(sbInsert('ops_events', {
    environment: ENV,
    kind: 'business',
    name,
    module: mod ?? 'unknown',
    level,
    user_id: isUuid(userId) ? userId : null,
    room_code: roomCode ?? null,
    context,
  }));

  return { name, module: mod, level };
}

/** Продуктовая метрика для дашборда (не ошибка). */
export function logMetric(name, { userId, roomCode, value = 1, context = {} } = {}) {
  if (!hasServiceKey()) return;
  safe(sbInsert('ops_metrics', {
    environment: ENV,
    name,
    user_id: isUuid(userId) ? userId : null,
    room_code: roomCode ?? null,
    value,
    context,
  }));
}

/** Регистрация когорты — без неё retention D1/D7 посчитать не из чего. */
export function logSignup(userId, { provider } = {}) {
  if (!hasServiceKey() || !isUuid(userId)) return;
  safe(sbInsert('ops_signups', {
    user_id: userId, environment: ENV, provider: provider ?? null,
  }, { upsert: true, onConflict: 'user_id' }));
}

/** Считает ошибки за последний час и шлёт разовый алерт при превышении. */
async function checkForSpike({ level, module: mod, message }) {
  const threshold = Number(process.env.ALERT_ERROR_THRESHOLD ?? 12);
  const since = new Date(Date.now() - 3600_000).toISOString();

  const rows = await sbSelect('ops_events', {
    select: 'id',
    environment: `eq.${ENV}`,
    kind: 'eq.error',
    level: 'in.(critical,error)',
    created_at: `gte.${since}`,
    limit: threshold + 1,
  });

  const count = rows?.length ?? 0;
  if (count < threshold) return;

  // Отметка о посланном алерте живёт в том же журнале: второй раз
  // за час не побеспокоим.
  const notified = await sbSelect('ops_events', {
    select: 'id',
    environment: `eq.${ENV}`,
    kind: 'eq.business',
    name: 'eq.alert_sent',
    created_at: `gte.${since}`,
    limit: 1,
  });
  if (notified?.length) return;

  await sbInsert('ops_events', {
    environment: ENV, kind: 'business', name: 'alert_sent',
    module: 'ops.alerting', level: LEVEL.INFO, context: { count, threshold },
  });

  await sendAlert(
    `🚨 MatchWatch [${ENV}]\nВсплеск ошибок: ${count}+ за час (порог ${threshold}).\n`
    + `Последняя: ${level.toUpperCase()} ${mod} — ${message}`,
  );
}

/** Доставка алерта: Telegram-бот, если настроен, иначе generic-вебхук. */
export async function sendAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID;
  try {
    if (token && chatId) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      return true;
    }
    if (process.env.ALERT_WEBHOOK_URL) {
      await fetch(process.env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return true;
    }
  } catch (error) {
    console.warn('[telemetry] алерт не доставлен:', error?.message ?? error);
  }
  return false;
}

export const telemetryEnv = ENV;
export const telemetryRelease = RELEASE;
export const sentryEnabled = sentry.enabled;
