/**
 * Обвязка серверлес-функций: CORS, разбор запроса, единый формат ошибки,
 * автоматическая отправка исключения в телеметрию.
 *
 * Ни один хендлер не должен ронять 500 без объяснения — клиент обязан
 * получить машиночитаемый код и человекочитаемое сообщение, чтобы показать
 * его вместо бесконечного спиннера.
 */

import { timingSafeEqual } from 'node:crypto';
import { LEVEL } from '../../shared/telemetry/events.js';
import { logError, flushTelemetry } from './telemetry.js';

/*
 * Кому браузер разрешит читать наши ответы.
 *
 * Здесь стоял суффикс `.vercel.app` — то есть доступ получал любой чужой
 * проект на Vercel, а их там миллионы. Настоящей беды это не давало:
 * всё чувствительное требует Bearer-токен, которого чужой сайт не знает,
 * а cookie мы не используем. Но раздавать доступ незнакомцам без причины
 * незачем — суффикс сужен до собственных развёрток.
 *
 * telegram.org нужен самому Mini App: он открывается в домене клиента.
 */
const ALLOWED_ORIGIN_SUFFIXES = ['telegram.org'];
const OWN_DEPLOYMENT = /^matchwatch[a-z0-9-]*\.vercel\.app$/;

function resolveOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return '*';
  const explicit = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.includes(origin)) return origin;
  try {
    const { hostname, protocol } = new URL(origin);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return origin;
    if (protocol === 'https:'
      && (OWN_DEPLOYMENT.test(hostname) || ALLOWED_ORIGIN_SUFFIXES.some((s) => hostname.endsWith(s)))) {
      return origin;
    }
  } catch { /* ignore */ }

  /*
   * Незнакомый origin. Раньше здесь отдавалась звёздочка — то есть отказ
   * превращался в разрешение для всех. Отдаём свой домен: браузер сверит
   * его с фактическим и ответ читать не даст.
   */
  return explicit[0] ?? 'https://matchwatch-seven.vercel.app';
}

export function sendJson(res, status, payload, { cacheSeconds = 0 } = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (cacheSeconds > 0) {
    res.setHeader('cache-control', `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`);
  } else {
    res.setHeader('cache-control', 'no-store');
  }
  res.end(JSON.stringify(payload));
}

export class ApiError extends Error {
  constructor(status, code, message, { context = {}, level = LEVEL.ERROR, expose = true } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.context = context;
    this.level = level;
    this.expose = expose;
  }
}

export const badRequest = (code, message, context) =>
  new ApiError(400, code, message, { context, level: LEVEL.WARNING });
export const notFound = (code, message, context) =>
  new ApiError(404, code, message, { context, level: LEVEL.WARNING });
export const unauthorized = (code, message, context) =>
  new ApiError(401, code, message, { context, level: LEVEL.WARNING });

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { throw badRequest('bad_json', 'Тело запроса не является корректным JSON'); }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw badRequest('bad_json', 'Тело запроса не является корректным JSON'); }
}

/**
 * @param {{methods?: string[], module: string, cacheSeconds?: number}} options
 * @param {(ctx: {req, res, query: URLSearchParams, body: object}) => Promise<any>} handler
 */
/**
 * Проверка служебного секрета.
 *
 * Прежняя логика пропускала запрос, если переменная окружения не задана:
 * «нет секрета — нечего сверять». На практике это значит, что забытая
 * переменная не ломает ничего заметного, а просто открывает эндпоинт
 * всему интернету — и узнать об этом неоткуда. Отсутствие секрета
 * теперь закрывает доступ, а не открывает его.
 *
 * Сравнение постоянного времени: обычное `!==` выходит на первом
 * несовпавшем символе, и по времени ответа секрет подбирается посимвольно.
 */
export function requireSecret(req, query, envName, { allowQuery = true } = {}) {
  const expected = process.env[envName];
  if (!expected) {
    throw new ApiError(503, 'secret_not_configured',
      `Эндпоинт закрыт: не задан ${envName}`, { level: LEVEL.CRITICAL });
  }

  const provided = req.headers?.authorization?.replace(/^Bearer\s+/i, '')
    ?? (allowQuery ? query?.get?.('token') : null);

  if (!provided || !timingSafeEqualStrings(provided, expected)) {
    throw new ApiError(401, 'unauthorized', 'Неверный или отсутствующий токен доступа',
      { level: LEVEL.WARNING });
  }
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Длину скрыть нельзя, но сравнить всё равно надо целиком.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function withHandler(options, handler) {
  const methods = options.methods ?? ['GET'];

  return async function wrapped(req, res) {
    const started = Date.now();
    res.setHeader('access-control-allow-origin', resolveOrigin(req));
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-matchwatch-client');
    res.setHeader('access-control-allow-methods', [...methods, 'OPTIONS'].join(', '));
    res.setHeader('vary', 'origin');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    if (!methods.includes(req.method)) {
      sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: `Метод ${req.method} не поддерживается` } });
      return;
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const body = methods.includes('POST') && req.method === 'POST' ? await readBody(req) : {};
      const result = await handler({ req, res, query: url.searchParams, body });
      if (res.writableEnded) return;
      /*
       * Журнал дописывается до ответа только там, где его об этом
       * попросили (`awaitTelemetry`).
       *
       * Serverless-функция живёт ровно до ответа: всё незавершённое
       * платформа обрывает вместе с контейнером. На практике вставки
       * успевают, и делать это правило общим значит платить лишним
       * обращением к базе в каждом запросе ради риска, который себя
       * не проявляет. А вот эндпоинт приёма телеметрии существует
       * ровно затем, чтобы записать, и ответить «принято», ничего
       * не записав, он не имеет права.
       */
      if (options.awaitTelemetry) await flushTelemetry();
      sendJson(res, 200, { ok: true, ...result, tookMs: Date.now() - started }, { cacheSeconds: options.cacheSeconds ?? 0 });
    } catch (error) {
      const isApi = error instanceof ApiError;
      const status = isApi ? error.status : 500;

      logError({
        message: error.message ?? 'Необработанная ошибка серверной функции',
        module: options.module,
        level: isApi ? error.level : LEVEL.CRITICAL,
        error,
        context: { path: req.url, method: req.method, ...(isApi ? error.context : {}) },
      });

      /*
       * На ошибке ждём всегда: сбой — единственное, что читают потом,
       * и потерянная запись о нём стоит дороже сотни миллисекунд.
       */
      await flushTelemetry();

      if (res.writableEnded) return;
      sendJson(res, status, {
        ok: false,
        error: {
          code: isApi ? error.code : 'internal_error',
          message: isApi && error.expose ? error.message : 'Внутренняя ошибка сервиса. Попробуйте ещё раз.',
          retryable: status >= 500 || status === 429,
        },
      });
    }
  };
}

/**
 * Свой публичный адрес.
 *
 * Нужен там, где сервис зовёт сам себя со стороны: вебхук Telegram и
 * обход разметки из базы. Оба должны считать этот адрес одинаково —
 * иначе бот зарегистрирует вебхук на одном хосте, а база пойдёт
 * стучаться на другой, и разойдутся они молча.
 *
 * Порядок важен. VERCEL_URL у каждой выкладки свой, включая предпросмотры,
 * поэтому явная переменная идёт первой: без неё настройка с превью
 * прописала бы в базу временный адрес, который завтра перестанет
 * существовать.
 */
export function publicBase(req) {
  const explicit = (process.env.PUBLIC_APP_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL ?? '').trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  return `https://${req.headers?.host ?? 'localhost'}`;
}
