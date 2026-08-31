/**
 * Клиент серверного API.
 *
 * Все запросы к TMDB идут через него — ключ TMDB живёт только на сервере.
 * Умеет: таймаут, один автоматический повтор на сетевой сбой, понятная
 * ошибка вместо вечного спиннера, короткий клиентский кэш ответов.
 */

import { ENV } from './env.js';
import { isOnline } from './network.js';
import { trackBusiness } from './telemetry.js';
import { BIZ, LEVEL, MODULE } from '../../shared/telemetry/events.js';

export class ApiClientError extends Error {
  constructor(message, { code, status, retryable = false } = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code ?? 'unknown';
    this.status = status ?? 0;
    this.retryable = retryable;
  }
}

const memoCache = new Map();
const inflight = new Map();
const MEMO_TTL = 120_000;

async function request(path, { method = 'GET', body, timeoutMs = 12_000, retries = 1, signal, accessToken } = {}) {
  if (!isOnline()) {
    throw new ApiClientError('Нет соединения с интернетом', { code: 'offline', retryable: true });
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    try {
      const res = await fetch(`${ENV.apiBase}${path}`, {
        method,
        headers: {
          'x-matchwatch-client': 'web',
          ...(body ? { 'content-type': 'application/json' } : {}),
          // Эндпоинты привязки работают от имени текущей сессии, а не анонимно.
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      /**
       * Статический хостинг (vite preview, `serve dist`, неверный rewrite
       * на Vercel) отдаёт на /api/* саму SPA — HTML с кодом 200.
       * Без этой проверки такой ответ выглядит как успешный, и ошибка
       * всплывает где-то дальше в виде невнятного TypeError.
       */
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) {
        throw new ApiClientError(
          'Бэкенд не отвечает: по адресу /api вернулась страница вместо данных. '
          + 'Похоже, приложение открыто без серверных функций.',
          { code: 'api_unavailable', status: res.status, retryable: false },
        );
      }

      const payload = await res.json().catch(() => null);

      if (!payload) {
        throw new ApiClientError('Сервис вернул пустой ответ',
          { code: 'empty_response', status: res.status, retryable: true });
      }

      if (!res.ok || payload.ok === false) {
        const err = payload?.error ?? {};
        const apiError = new ApiClientError(
          err.message ?? `Запрос ${path} завершился ошибкой ${res.status}`,
          { code: err.code, status: res.status, retryable: err.retryable ?? res.status >= 500 },
        );
        if (apiError.retryable && attempt < retries) { lastError = apiError; continue; }
        throw apiError;
      }

      return payload;
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error instanceof ApiClientError) throw error;
      if (error.name === 'AbortError' && signal?.aborted) throw error;

      lastError = new ApiClientError(
        error.name === 'AbortError'
          ? 'Сервис не ответил вовремя. Проверьте соединение.'
          : 'Не удалось связаться с сервисом',
        { code: error.name === 'AbortError' ? 'timeout' : 'network', retryable: true },
      );
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  throw lastError ?? new ApiClientError('Неизвестная ошибка запроса', { code: 'unknown', retryable: true });
}

/** GET с дедупликацией одновременных запросов и коротким кэшем. */
async function cachedGet(path, { ttl = MEMO_TTL, ...options } = {}) {
  const hit = memoCache.get(path);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (inflight.has(path)) return inflight.get(path);

  const promise = request(path, options)
    .then((value) => {
      memoCache.set(path, { value, expiresAt: Date.now() + ttl });
      return value;
    })
    .finally(() => inflight.delete(path));

  inflight.set(path, promise);
  return promise;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

export const api = {
  /** Каталог под фильтры. Возвращает «лёгкие» тайтлы. */
  async catalog(params, options) {
    const payload = await cachedGet(`/tmdb/catalog${qs(params)}`, { ttl: 5 * 60_000, ...options });
    if (!payload?.titles?.length) {
      trackBusiness(BIZ.TMDB_EMPTY_RESULT, { module: MODULE.CATALOG, context: params ?? {} });
    }
    return payload;
  },

  /** Полная карточка с keywords — основа тегов. */
  title: (id, options) => cachedGet(`/tmdb/title${qs({ id })}`, { ttl: 30 * 60_000, ...options }),

  /** Догрузка детальных тегов пачкой (фоном под колоду). */
  enrich: (ids, options) => request('/tmdb/enrich', { method: 'POST', body: { ids }, ...options }),

  search: (q, type = 'movie', options) => cachedGet(`/tmdb/search${qs({ q, type })}`, { ttl: 5 * 60_000, ...options }),

  person: (id, options) => cachedGet(`/tmdb/person${qs({ id })}`, { ttl: 30 * 60_000, ...options }),
  popularPeople: (page = 1, options) => cachedGet(`/tmdb/person${qs({ popular: 1, page })}`, { ttl: 60 * 60_000, ...options }),

  authTelegram: (initData) => request('/auth/telegram', { method: 'POST', body: { initData }, retries: 2 }),

  /** Диагностика конфигурации входа: какой бот настроен и есть ли ключи. */
  authTelegramConfig: () => request('/auth/telegram', { retries: 0 }),

  /** Какие способы входа привязаны к текущему аккаунту. */
  identityStatus: (accessToken) => request('/auth/link-telegram', { accessToken, retries: 0 }),

  /** Человек разрешил боту писать ему — записываем право на доставку. */
  allowNotifications: (initData) =>
    request('/telegram/notify-allow', { method: 'POST', body: { initData }, retries: 1 }),

  linkTelegram: (initData, accessToken) =>
    request('/auth/link-telegram', { method: 'POST', body: { initData }, accessToken, retries: 0 }),

  unlinkTelegram: (accessToken) =>
    request('/auth/link-telegram', { method: 'DELETE', accessToken, retries: 0 }),

  /* ── Премиум ── */

  /** Что у человека с подпиской. Заодно приносит цену и список выгод. */
  billingStatus: async () => request('/billing/status', {
    accessToken: await sessionToken(), retries: 1,
  }),

  /** Бесплатный месяц первой волне. Второй раз базой не принимается. */
  billingPromo: async () => request('/billing/promo', {
    method: 'POST', accessToken: await sessionToken(), retries: 0,
  }),

  /**
   * Ссылка на счёт в звёздах.
   *
   * Без повторов намеренно: каждый вызов выписывает НОВЫЙ счёт,
   * и молчаливый ретрай при обрыве ответа оставил бы человеку два.
   */
  billingInvoice: async () => request('/billing/invoice', {
    method: 'POST', accessToken: await sessionToken(), retries: 0,
  }),

  /*
   * Метрики открываются по своей же учётке: признак `is_ops` в профиле.
   * Отдельный токен остаётся необязательным запасным путём — раньше
   * без него дашборд не открывался вообще никому, включая владельца.
   */
  metrics: async (days, token) => request(`/ops/metrics${qs({ days, token })}`, {
    timeoutMs: 20_000,
    accessToken: token ? undefined : await sessionToken(),
  }),

  /**
   * Разбор фразы «чего хочется сегодня».
   *
   * Минута на ожидание и ни одной повторной попытки — оба решения
   * намеренные. Двенадцати секунд по умолчанию думающей модели мало,
   * и обрыв по таймауту здесь означал бы подборку не по запросу.
   * Повтор же стоил бы второго обращения к модели и мог вернуть другой
   * разбор: человек попросил один раз — разбираем один раз.
   */
  aiInterpret: async (text, options) =>
    request('/ai/interpret', {
      method: 'POST',
      body: { text },
      timeoutMs: 60_000,
      retries: 0,
      /*
       * Токен сессии обязателен: за этим вызовом стоит платная модель,
       * и открытым он был бы выбран скриптом за минуты.
       */
      accessToken: await sessionToken(),
      ...options,
    }),

  /** Почему подборка предложила этот фильм. */
  aiExplain: async (payload, options) =>
    request('/ai/explain', {
      method: 'POST',
      body: payload,
      timeoutMs: 45_000,
      retries: 0,
      accessToken: await sessionToken(),
      ...options,
    }),
};

/**
 * Токен текущей сессии.
 *
 * Берётся на каждый вызов, а не запоминается: токен живёт около часа,
 * и сохранённый однажды однажды же и протухнет — посреди сеанса,
 * без всякого объяснения для человека.
 */
async function sessionToken() {
  try {
    const { supabase, supabaseReady } = await import('./supabase.js');
    if (!supabaseReady()) return null;
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Единый разбор ошибки в текст для пользователя. */
export function describeError(error) {
  if (!(error instanceof ApiClientError)) {
    return { text: 'Что-то пошло не так. Попробуйте ещё раз.', retryable: true };
  }
  const map = {
    offline: 'Нет интернета. Проверьте соединение — данные подтянутся сами.',
    timeout: 'Сервис долго не отвечает. Попробуем ещё раз?',
    network: 'Не получилось связаться с сервисом.',
    api_unavailable: 'Бэкенд недоступен: /api не обслуживается. Запустите «npm run dev» '
      + '(не «preview») или разверните проект на Vercel — там функции из api/ поднимаются сами.',
    empty_response: 'Сервис ответил пустотой. Попробуем ещё раз?',
    tmdb_rate_limited: 'Каталог перегружен запросами. Подождите пару секунд.',
    tmdb_not_configured: 'Каталог не настроен: не задан ключ TMDB.',
    tmdb_upstream_error: 'Каталог TMDB сейчас недоступен.',
    tmdb_unreachable: 'Каталог TMDB не отвечает.',
    telegram_not_configured: 'Вход через Telegram не настроен: не задан токен бота.',
    /*
     * initdata_invalid намеренно НЕ переопределяется. Сервер знает, каким
     * ботом он проверяет подпись, и называет его в сообщении; захардкоженный
     * здесь текст только увёл бы от настоящей причины — однажды уже увёл.
     */
    initdata_expired: 'Сессия Telegram устарела. Переоткройте приложение.',
    initdata_missing: 'Telegram не передал данные авторизации. Откройте приложение '
      + 'через бота, а не по прямой ссылке.',
    linking_not_configured: 'Привязка Telegram не настроена на сервере '
      + '(нет SUPABASE_SERVICE_ROLE_KEY).',
    telegram_linked_elsewhere: 'Этот Telegram уже привязан к другому аккаунту.',
    last_login_method: 'Telegram — единственный вход в аккаунт. Сначала добавьте email.',
    session_required: 'Нужен вход в аккаунт.',
    session_invalid: 'Сессия истекла — войдите заново.',
  };
  return { text: map[error.code] ?? error.message, retryable: error.retryable };
}

export function clearApiCache() {
  memoCache.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    trackBusiness(BIZ.OFFLINE_DEGRADED, { module: MODULE.NETWORK, level: LEVEL.INFO });
  });
}
