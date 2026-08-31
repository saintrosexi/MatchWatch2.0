/**
 * POST /api/ops/events
 * Приём телеметрии с фронтенда. Клиент шлёт пачками, чтобы не молотить
 * сетью на каждом свайпе.
 *
 * Фронтенд и бэкенд — разные источники сбоев, но журнал у них общий:
 * так «комната не найдена» на клиенте и «rules отклонили запись» на сервере
 * видны в одном месте и с одинаковой структурой.
 */

import { withHandler, badRequest } from './http.js';
import { logBusinessEvent, logError, logMetric } from './telemetry.js';
import { BIZ, LEVEL, METRIC, MODULE } from '../../shared/telemetry/events.js';
import { normalizeRoomCode } from '../../shared/model/roomCode.js';

const MAX_BATCH = 40;
const KNOWN_BIZ = new Set(Object.values(BIZ));
const KNOWN_METRICS = new Set(Object.values(METRIC));
const KNOWN_LEVELS = new Set(Object.values(LEVEL));

export const eventsHandler = withHandler({
  methods: ['POST'],
  module: MODULE.OPS,
  /* Единственная задача эндпоинта — записать. Отвечать «принято»
     до того, как запись легла, здесь означает соврать. */
  awaitTelemetry: true,
}, async ({ body, req }) => {
  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_BATCH) : null;
  if (!events?.length) throw badRequest('events_required', 'Передайте массив events');

  const userId = typeof body?.userId === 'string' ? body.userId.slice(0, 64) : null;
  const clientContext = {
    client: 'web',
    platform: String(body?.platform ?? 'unknown').slice(0, 32),
    release: String(body?.release ?? 'unknown').slice(0, 40),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
  };

  let accepted = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const roomCode = normalizeRoomCode(event.roomCode);
    const module_ = typeof event.module === 'string' ? event.module.slice(0, 64) : MODULE.UI;
    const context = {
      ...clientContext,
      ...(event.context && typeof event.context === 'object' ? sanitize(event.context) : {}),
      // Состояние сети на момент сбоя — критично для разбора «залипшего» UI.
      online: event.online ?? null,
      connection: event.connection ?? null,
    };

    if (event.type === 'metric' && KNOWN_METRICS.has(event.name)) {
      logMetric(event.name, { userId, roomCode, value: Number(event.value) || 1, context });
      accepted += 1;
    } else if (event.type === 'biz' && KNOWN_BIZ.has(event.name)) {
      logBusinessEvent(event.name, {
        module: module_, userId, roomCode,
        level: KNOWN_LEVELS.has(event.level) ? event.level : LEVEL.WARNING,
        context,
      });
      accepted += 1;
    } else if (event.type === 'error') {
      const error = new Error(String(event.message ?? 'Клиентская ошибка').slice(0, 500));
      error.name = String(event.errorName ?? 'ClientError').slice(0, 60);
      if (typeof event.stack === 'string') error.stack = event.stack.slice(0, 6000);
      logError({
        message: error.message,
        module: module_,
        level: KNOWN_LEVELS.has(event.level) ? event.level : LEVEL.ERROR,
        error, userId, roomCode, context,
      });
      accepted += 1;
    }
  }

  return { accepted, received: events.length };
});

/** Никаких сырых пользовательских данных в журнале — только плоские примитивы. */
function sanitize(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj).slice(0, 25)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key.slice(0, 40)] = typeof value === 'string' ? value.slice(0, 300) : value;
    }
  }
  return out;
}
