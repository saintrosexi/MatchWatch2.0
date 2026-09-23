/**
 * MatchWatch — куда вести человека, пришедшего из Telegram.
 *
 * ЕДИНСТВЕННЫЙ источник правды о разборе `start_param`. Через него
 * проходят и приглашение в комнату, и кнопки бота-навигатора: иначе
 * бот отправляет одно, а приложение понимает другое, и человек попадает
 * не туда, куда нажал.
 *
 * Разделение однозначное и не требует префиксов: код комнаты — ровно
 * пять цифр, назначение — слово. Пересечься они не могут.
 */

import { normalizeRoomCode } from './roomCode.js';

/**
 * Куда бот умеет отправить.
 *
 * Значения совпадают с ключами экранов в приложении намеренно: лишний
 * слой перевода между «что написал бот» и «какой экран открылся» —
 * это ещё одно место, где они разъезжаются.
 */
export const DESTINATION = Object.freeze({
  DECK: 'deck',
  COLLECTION: 'collection',
  ROOMS: 'rooms',
  MINE: 'mine',
  ME: 'me',
  NEWS: 'news',
  /** Не экран, а витрина подписки поверх ленты. */
  PREMIUM: 'premium',
});

const KNOWN = new Set(Object.values(DESTINATION));

/**
 * Префикс профиля.
 *
 * Ник нельзя отличить от названия раздела без метки: человек может
 * зарегистрировать себе `rooms` или `deck` и увести всех, кто нажал
 * кнопку бота, на свою страницу. Префикс снимает эту двусмысленность
 * раз и навсегда.
 *
 * `u_`, а не `@`: Telegram обрезает `start_param` до букв, цифр,
 * дефиса и подчёркивания — собачка до нас просто не доедет.
 */
const PROFILE_PREFIX = 'u_';

/** Собирает `start_param` для ссылки на профиль. */
export const profileStartParam = (username) => `${PROFILE_PREFIX}${String(username ?? '').trim()}`;

/**
 * Префикс метки кампании: `t.me/<bot>/<app>?startapp=src_tiktok`.
 *
 * Продвижение без меток — стрельба вслепую: видно, что людей стало
 * больше, и не видно, какой из десяти постов их привёл. Метка ничего
 * не открывает, приложение стартует с ленты как обычно, — она только
 * подписывает первый заход.
 */
const SOURCE_PREFIX = 'src_';

/**
 * Метка источника в том виде, в каком её можно хранить и сравнивать.
 *
 * Telegram пропускает в `start_param` только латиницу, цифры, `_` и `-`,
 * поэтому тот же алфавит держим и для `utm_source`: одна кампания
 * не должна считаться двумя из-за регистра или пробела на конце.
 */
export function normalizeSourceTag(raw) {
  const tag = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return tag || null;
}

/** Собирает `start_param` для ссылки из кампании. */
export const sourceStartParam = (tag) => {
  const clean = normalizeSourceTag(tag);
  return clean ? `${SOURCE_PREFIX}${clean}` : null;
};

/**
 * @param {string|null|undefined} raw значение `start_param`
 * @returns {{kind: 'room', code: string}
 *   | {kind: 'view', to: string}
 *   | {kind: 'profile', username: string}
 *   | {kind: 'source', source: string}
 *   | null}
 */
export function parseStartParam(raw) {
  if (raw === null || raw === undefined) return null;

  const code = normalizeRoomCode(raw);
  if (code) return { kind: 'room', code };

  const value = String(raw).trim().toLowerCase();

  if (value.startsWith(PROFILE_PREFIX)) {
    const username = value.slice(PROFILE_PREFIX.length);
    return username ? { kind: 'profile', username } : null;
  }

  if (value.startsWith(SOURCE_PREFIX)) {
    const source = normalizeSourceTag(value.slice(SOURCE_PREFIX.length));
    return source ? { kind: 'source', source } : null;
  }

  if (KNOWN.has(value)) return { kind: 'view', to: value };

  return null;
}

/** Откуда пришли, когда метки кампании нет, но сама ссылка говорит за себя. */
export const SOURCE = Object.freeze({
  /** Ссылка-приглашение в комнату — друг позвал. */
  INVITE: 'invite',
  /** Ссылка на чужой профиль. */
  PROFILE: 'profile',
  /** Кнопка бота-навигатора. */
  BOT: 'bot',
});

/**
 * Источник первого захода — для отчёта «какой канал работает».
 *
 * Метка кампании важнее всего остального: человек, пришедший из поста
 * по ссылке `src_habr`, — заслуга поста, а не «органика». Без метки
 * источник выводится из самой ссылки: приглашение в комнату — это
 * сарафан, и его стоит видеть отдельной строкой, потому что только
 * он растёт сам.
 *
 * @param {string|null|undefined} raw `start_param` из Telegram
 * @param {string} [search] строка запроса страницы — для `utm_source` в вебе
 * @returns {string|null} метка или null, если зашли напрямую
 */
export function acquisitionSource(raw, search = '') {
  const parsed = parseStartParam(raw);
  if (parsed?.kind === 'source') return parsed.source;

  const params = new URLSearchParams(search);
  const utm = normalizeSourceTag(params.get('utm_source') ?? params.get('src'));
  if (utm) return utm;

  if (parsed?.kind === 'room' || params.get('room')) return SOURCE.INVITE;
  if (parsed?.kind === 'profile') return SOURCE.PROFILE;
  if (parsed?.kind === 'view') return SOURCE.BOT;
  return null;
}
