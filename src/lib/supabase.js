/**
 * Клиент Supabase.
 *
 * Инициализация «мягкая»: если ключей нет или сеть недоступна, приложение
 * переходит в локальный режим (личная лента работает, комнаты — нет),
 * а не показывает белый экран.
 */

import { createClient } from '@supabase/supabase-js';
import { ENV, isSupabaseConfigured } from './env.js';
import { trackBusiness, trackError } from './telemetry.js';
import { BIZ, LEVEL, MODULE } from '../../shared/telemetry/events.js';

/** Потолок ожидания одного запроса к Supabase. */
const REQUEST_TIMEOUT_MS = 20000;

let client = null;
let initError = null;

if (isSupabaseConfigured()) {
  try {
    client = createClient(ENV.supabase.url, ENV.supabase.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // В Telegram Mini App нет обычной адресной строки, и разбор
        // токена из URL только мешает.
        detectSessionInUrl: !ENV.isTelegramShell,
        storageKey: 'mw3.auth',
      },
      realtime: {
        // Свайпы идут пачками; больше десяти событий в секунду на комнату
        // не бывает, а лимит бережёт бесплатный тариф.
        params: { eventsPerSecond: 10 },
      },
      global: {
        headers: { 'x-matchwatch-client': 'web' },
        /*
         * Ни один запрос не имеет права висеть вечно.
         *
         * У fetch нет тайм-аута по умолчанию, и в мобильном WebView
         * запрос, ушедший в потерянное соединение, не завершается ни
         * успехом, ни ошибкой — просто молчит. Всё, что его ждёт,
         * молчит вместе с ним: заставка, лента, комната.
         *
         * Двадцать секунд — с запасом на медленную сеть и всё равно
         * конечны. Оборванный запрос станет обычной ошибкой, а её
         * приложение уже умеет показывать и повторять.
         *
         * Realtime это не трогает: он живёт на WebSocket, не на fetch.
         */
        fetch: (input, init = {}) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

          /* Свой abort вызывающего должен работать наравне с нашим. */
          init.signal?.addEventListener('abort', () => controller.abort(), { once: true });

          return fetch(input, { ...init, signal: controller.signal })
            .finally(() => clearTimeout(timer));
        },
      },
    });
  } catch (error) {
    initError = error;
    trackError('Не удалось инициализировать Supabase', {
      module: MODULE.AUTH_SESSION, level: LEVEL.CRITICAL, error,
    });
  }
} else {
  initError = new Error('Supabase не сконфигурирован (нет VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)');
}

export const supabase = client;
export const supabaseReady = () => Boolean(client);
export const supabaseInitError = () => initError;

/**
 * Коды ошибок, которые поднимают RPC-функции комнат.
 * Держатся здесь, потому что это контракт между SQL и клиентом.
 */
export const PG_ERROR = Object.freeze({
  INVALID_CODE: 'MW400',
  FORBIDDEN: 'MW403',
  NOT_FOUND: 'MW404',
  ROOM_FULL: 'MW409',
  /** Комнаты бесплатного тарифа на этот месяц кончились. */
  LIMIT_REACHED: 'MW402',
  EXPIRED: 'MW410',
  CODE_EXHAUSTED: 'MW500',
});

/** Отказ RLS-политики. Postgres отдаёт это отдельным кодом — ловим явно. */
const RLS_CODES = new Set(['42501', 'PGRST301', 'PGRST116']);

/**
 * Обёртка над запросом к Supabase, разделяющая три разных беды:
 * отказ политики доступа, доменную ошибку из RPC и сетевой сбой.
 * Без этого разделения «нет прав» тонет среди таймаутов.
 */
export async function guarded(operation, { module: mod, roomCode, description }) {
  try {
    const result = await operation();

    if (result?.error) {
      const { error } = result;

      if (RLS_CODES.has(error.code)) {
        trackBusiness(BIZ.DB_POLICY_DENIED, {
          module: mod ?? MODULE.DB_POLICY,
          level: LEVEL.ERROR,
          room: roomCode,
          context: { operation: description ?? 'unknown', pgCode: error.code },
        });
      } else if (!String(error.code ?? '').startsWith('MW')) {
        // MW* — ожидаемые доменные ошибки (комната не найдена и т. п.),
        // их логирует вызывающий код с правильным бизнес-событием.
        trackError(`Запрос к базе не удался: ${description ?? 'unknown'}`, {
          module: mod ?? MODULE.DB_POLICY,
          error: Object.assign(new Error(error.message), { name: 'PostgrestError' }),
          context: { roomCode, pgCode: error.code, details: error.details },
        });
      }

      throw Object.assign(new Error(error.message), {
        code: error.code, details: error.details, hint: error.hint,
      });
    }

    return result?.data ?? result;
  } catch (error) {
    if (error?.code) throw error;
    trackError(`Сбой обращения к базе: ${description ?? 'unknown'}`, {
      module: mod ?? MODULE.DB_POLICY, error, context: { roomCode },
    });
    throw error;
  }
}
