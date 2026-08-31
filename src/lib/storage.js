/**
 * Локальное хранилище с защитой от приватного режима Safari и от мусора
 * в значениях. Здесь живут только клиентские предпочтения и черновики
 * состояния — источник правды всегда в базе.
 */

const PREFIX = 'mw3:';
const memory = new Map();

const backend = (() => {
  try {
    const probe = `${PREFIX}__probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
})();

export function loadLocal(key, fallback = null) {
  const full = PREFIX + key;
  try {
    const raw = backend ? backend.getItem(full) : memory.get(full);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveLocal(key, value) {
  const full = PREFIX + key;
  try {
    const raw = JSON.stringify(value);
    if (backend) backend.setItem(full, raw);
    else memory.set(full, raw);
    return true;
  } catch {
    return false;
  }
}

export function removeLocal(key) {
  const full = PREFIX + key;
  try {
    if (backend) backend.removeItem(full);
    else memory.delete(full);
  } catch { /* игнорируем */ }
}

export const STORAGE_KEYS = {
  ONBOARDED: 'onboarded',
  FILTERS: 'filters',
  PREFS: 'prefs',
  LAST_ROOMS: 'recent-rooms',
  DECK_DRAFT: 'deck-draft',
  OPS_TOKEN: 'ops-token',
  GUEST_TASTE: 'guest-taste',
  /**
   * Прочитанные новости.
   *
   * На устройстве, а не в профиле: новость про интерфейс касается того
   * экрана, с которого человек смотрит, и синхронизировать её между
   * телефоном и десктопом незачем. Заодно баннер не ждёт сети.
   */
  NEWS_SEEN: 'news-seen',
  /**
   * Что рулетка показывала в последние прокрутки.
   *
   * На устройстве, а не в профиле: это защита от «опять то же самое»
   * в пределах одного вечера, а не часть вкуса. Синхронизировать
   * между телефоном и десктопом нечего.
   */
  ROULETTE_RECENT: 'roulette-recent',
};
