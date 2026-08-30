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
 * @param {string|null|undefined} raw значение `start_param`
 * @returns {{kind: 'room', code: string}
 *   | {kind: 'view', to: string}
 *   | {kind: 'profile', username: string}
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

  if (KNOWN.has(value)) return { kind: 'view', to: value };

  return null;
}
