/**
 * MatchWatch — словарь телеметрии.
 *
 * Разделены три вещи, которые часто смешивают:
 *   MODULE  — где произошло (фича/слой), проставляется тегом во все события;
 *   BIZ     — сбой логики, который НЕ является исключением кода
 *             (комната не найдена, TMDB пустой, rules отклонили запись).
 *             Обычный error-трекер такое не ловит — логируем явно;
 *   METRIC  — продуктовые метрики для дашборда (не ошибки вовсе).
 */

export const LEVEL = Object.freeze({
  CRITICAL: 'critical',
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});

export const MODULE = Object.freeze({
  AUTH_TELEGRAM: 'auth.telegram-init-data',
  AUTH_EMAIL: 'auth.email',
  AUTH_SESSION: 'auth.session',
  TMDB_PROXY: 'tmdb.proxy',
  TMDB_CACHE: 'tmdb.cache',
  CATALOG: 'catalog.load',
  DECK: 'deck.build',
  SWIPE_MATCH: 'swipe.match-calc',
  ROOMS_CREATE: 'rooms.create',
  ROOMS_JOIN: 'rooms.join',
  ROOMS_SYNC: 'rooms.sync',
  ROOMS_SWIPE: 'rooms.swipe',
  ROOMS_TTL: 'rooms.ttl',
  TASTE: 'taste.profile',
  STARS: 'stars.hub',
  VAULT: 'vault.watchlist',
  ROULETTE: 'roulette.spin',
  SHARE: 'share.match-card',
  TELEGRAM_SDK: 'telegram.sdk',
  DB_POLICY: 'db.rls-policy',
  NETWORK: 'net.connectivity',
  UI: 'ui.render',
  OPS: 'ops.pipeline',
  BOT: 'telegram.bot',
});

/** Бизнес-сбои: логика не сработала, хотя код не упал. */
export const BIZ = Object.freeze({
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_EXPIRED: 'room_expired',
  ROOM_FULL: 'room_full',
  ROOM_CODE_INVALID: 'room_code_invalid',
  ROOM_CODE_COLLISION: 'room_code_collision',
  SWIPE_RACE_RETRY: 'swipe_race_retry',
  SWIPE_TRANSACTION_ABORTED: 'swipe_transaction_aborted',
  TMDB_EMPTY_RESULT: 'tmdb_empty_result',
  TMDB_RATE_LIMITED: 'tmdb_rate_limited',
  TMDB_UPSTREAM_ERROR: 'tmdb_upstream_error',
  DB_POLICY_DENIED: 'db_policy_denied',
  TELEGRAM_INITDATA_INVALID: 'telegram_initdata_invalid',
  TELEGRAM_INITDATA_EXPIRED: 'telegram_initdata_expired',
  TELEGRAM_LINKED: 'telegram_linked',
  TELEGRAM_UNLINKED: 'telegram_unlinked',
  DECK_EXHAUSTED: 'deck_exhausted',
  DECK_EMPTY_AFTER_FILTERS: 'deck_empty_after_filters',
  OFFLINE_DEGRADED: 'offline_degraded',
  RECONNECT_RECOVERED: 'reconnect_recovered',
  PAYMENT_DECLINED: 'payment_declined',
  PAYMENT_DUPLICATE: 'payment_duplicate',
});

/** Продуктовые метрики — питают дашборд аналитики. */
export const METRIC = Object.freeze({
  APP_OPEN: 'app_open',
  SIGN_IN: 'sign_in',
  ONBOARDING_DONE: 'onboarding_done',
  SWIPE: 'swipe',
  FAVORITE: 'favorite',
  ROOM_CREATED: 'room_created',
  ROOM_JOINED: 'room_joined',
  ROOM_INVITE_SENT: 'room_invite_sent',
  ROOM_MESSAGE_SENT: 'room_message_sent',
  MATCH: 'match',
  MATCH_SHARED: 'match_shared',
  WATCHLIST_ADD: 'watchlist_add',
  WATCHED_MARK: 'watched_mark',
  ROULETTE_SPIN: 'roulette_spin',
  STAR_DECK: 'star_deck_generated',
  BOT_STARTED: 'bot_started',
  BOT_NOTIFIED: 'bot_notified',

  /*
   * Шаги воронки первой волны.
   *
   * `ONBOARDING_DONE` был здесь и раньше, но без начала шага посчитать
   * отвал невозможно: видно, сколько дошло, и не видно, из скольких.
   * Остальные ступени уже собирались (`ROOM_INVITE_SENT`, `ROOM_JOINED`,
   * `MATCH`) — не хватало ровно двух крайних.
   */
  ONBOARDING_STARTED: 'onboarding_started',

  /* Премиум: показ витрины, промо и оплата. */
  PREMIUM_VIEWED: 'premium_viewed',
  PREMIUM_PROMO_ACTIVATED: 'premium_promo_activated',
  PREMIUM_PURCHASED: 'premium_purchased',
  PREMIUM_CREDITED: 'premium_credited',

  /* Объявление во весь экран: показали и что с ним сделали. */
  NEWS_SHOWN: 'news_shown',
  NEWS_ACTED: 'news_acted',
});

/** Окружения разделены, чтобы локальная разработка не будила прод-алерты. */
export function resolveEnvironment(explicit) {
  if (explicit) return explicit;
  const host = globalThis.location?.hostname ?? '';
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return 'dev';
  if (host.includes('-git-') || host.startsWith('staging') || host.includes('vercel.app')) return 'staging';
  if (!host) {
    const nodeEnv = globalThis.process?.env?.VERCEL_ENV ?? globalThis.process?.env?.NODE_ENV;
    if (nodeEnv === 'production') return 'prod';
    if (nodeEnv === 'preview') return 'staging';
    return 'dev';
  }
  return 'prod';
}

/** Уровни, при превышении частоты которых должен срабатывать алерт. */
export const ALERTABLE_LEVELS = [LEVEL.CRITICAL, LEVEL.ERROR];
