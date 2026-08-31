/**
 * Обёртка над Telegram Mini Apps SDK.
 *
 * Правила, которые здесь зафиксированы:
 *  — тактильный отклик берём из нативного Telegram API, а не Web Vibration:
 *    внутри TMA они ведут себя по-разному на iOS и Android, и web-вибрация
 *    на iOS попросту не работает;
 *  — тема приложения синхронизируется с themeParams клиента;
 *  — fullscreen запрашивается только если клиент это умеет (Bot API 8.0+),
 *    иначе просто expand();
 *  — весь SDK опционален: вне Telegram модуль отдаёт заглушки, приложение
 *    работает как обычный веб.
 */

import { trackBusiness, trackError } from './telemetry.js';
import { BIZ, LEVEL, MODULE } from '../../shared/telemetry/events.js';
import { normalizeRoomCode } from '../../shared/model/roomCode.js';
import { parseStartParam, profileStartParam } from '../../shared/model/startParam.js';
import { ENV } from './env.js';

const wa = () => globalThis.Telegram?.WebApp ?? null;

export const isTelegram = () => Boolean(wa()?.initData || wa()?.initDataUnsafe?.user);

const versionAtLeast = (target) => {
  const current = wa()?.version ?? '6.0';
  const a = current.split('.').map(Number);
  const b = target.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
};

/** Инициализация шелла: тема, безопасные зоны, fullscreen, закрытие свайпом. */
export function initTelegramShell({ onThemeChange, onViewportChange } = {}) {
  const app = wa();
  if (!app) return { available: false };

  try {
    app.ready();
    app.expand?.();
    app.disableVerticalSwipes?.();

    if (versionAtLeast('8.0') && typeof app.requestFullscreen === 'function') {
      try { app.requestFullscreen(); } catch { /* клиент мог отказать — не критично */ }
    }

    applyTheme(app);
    applyInsets(app);

    app.onEvent?.('themeChanged', () => { applyTheme(app); onThemeChange?.(readTheme()); });
    app.onEvent?.('viewportChanged', () => { applyInsets(app); onViewportChange?.(); });
    app.onEvent?.('fullscreenChanged', () => applyInsets(app));

    return { available: true, version: app.version, platform: app.platform };
  } catch (error) {
    trackError('Не удалось инициализировать Telegram WebApp', {
      module: MODULE.TELEGRAM_SDK, level: LEVEL.ERROR, error,
    });
    return { available: false };
  }
}

function applyTheme(app) {
  const params = app.themeParams ?? {};
  const scheme = app.colorScheme ?? 'dark';
  document.documentElement.dataset.theme = scheme;
  document.documentElement.dataset.tgPlatform = app.platform ?? 'unknown';

  // Цвета шапки/фона клиента подгоняем под наш кинозал, а не наоборот.
  try {
    app.setHeaderColor?.('#000000');
    app.setBackgroundColor?.('#000000');
    app.setBottomBarColor?.('#000000');
  } catch { /* старые клиенты не умеют — не страшно */ }

  if (params.link_color) document.documentElement.style.setProperty('--tg-link', params.link_color);
}

function applyInsets(app) {
  const root = document.documentElement.style;
  const content = app.contentSafeAreaInset ?? {};
  const safe = app.safeAreaInset ?? {};
  root.setProperty('--tg-top', `${(content.top ?? 0) + (safe.top ?? 0)}px`);
  root.setProperty('--tg-bottom', `${(content.bottom ?? 0) + (safe.bottom ?? 0)}px`);
  if (app.viewportStableHeight) {
    root.setProperty('--tg-viewport', `${app.viewportStableHeight}px`);
  }
}

export const readTheme = () => wa()?.colorScheme ?? 'dark';

/**
 * Клиент, в котором открыт Mini App: 'ios', 'android', 'tdesktop',
 * 'macos', 'weba', 'webk'. Отличать телефон от компьютера по ширине
 * окна недостаточно — окно Telegram Desktop бывает и узким, но ввод
 * там мышью, а не пальцем.
 */
export const telegramPlatform = () => wa()?.platform ?? null;

/** Мобильные клиенты Telegram — единственные, где интерфейс держат в руке. */
const MOBILE_CLIENTS = new Set(['android', 'android_x', 'ios']);

export const isTelegramMobile = () => MOBILE_CLIENTS.has(telegramPlatform() ?? '');
export const getInitData = () => wa()?.initData ?? null;
export const getTelegramUser = () => wa()?.initDataUnsafe?.user ?? null;

/** Код комнаты из deep-link `t.me/<bot>/<app>?startapp=CODE`. */
/** Сырое значение `start_param` — для разбора на стороне приложения. */
export const getStartParamRaw = () => rawStartParam();

const rawStartParam = () => wa()?.initDataUnsafe?.start_param
  ?? new URLSearchParams(globalThis.location?.search ?? '').get('tgWebAppStartParam');

export function getStartRoomCode() {
  return normalizeRoomCode(rawStartParam());
}

/**
 * Раздел, на котором нужно открыться, — из кнопок бота-навигатора.
 *
 * Тот же `start_param`, что и у приглашения в комнату: код — пять цифр,
 * назначение — слово, пересечься они не могут. Разбор один на бота
 * и приложение, иначе кнопка ведёт не туда, куда обещает подпись.
 *
 * @returns {string|null} значение из `DESTINATION` или null
 */
export function getStartDestination() {
  const parsed = parseStartParam(rawStartParam());
  return parsed?.kind === 'view' ? parsed.to : null;
}

/* ── Тактильный отклик ─────────────────────────────────────────── */

let hapticsEnabled = true;
export const setHapticsEnabled = (value) => { hapticsEnabled = Boolean(value); };

/**
 * @param {'light'|'medium'|'heavy'|'rigid'|'soft'|'success'|'warning'|'error'|'select'} kind
 */
export function haptic(kind = 'light') {
  if (!hapticsEnabled) return;
  const hf = wa()?.HapticFeedback;

  try {
    if (hf) {
      if (kind === 'select') { hf.selectionChanged?.(); return; }
      if (['success', 'warning', 'error'].includes(kind)) { hf.notificationOccurred?.(kind); return; }
      hf.impactOccurred?.(kind);
      return;
    }
  } catch { /* падаем в веб-вибрацию */ }

  // Вне Telegram — Web Vibration API как запасной вариант (Android/desktop Chrome).
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const pattern = {
      light: 10, medium: 18, heavy: 32, rigid: 14, soft: 8,
      select: 6, success: [12, 40, 20], warning: [18, 60, 18], error: [26, 50, 26],
    }[kind] ?? 12;
    try { navigator.vibrate(pattern); } catch { /* политика браузера */ }
  }
}

/* ── Кнопки клиента ────────────────────────────────────────────── */

export function setBackButton(handler) {
  const bb = wa()?.BackButton;
  if (!bb) return () => {};
  bb.onClick(handler);
  bb.show();
  return () => { bb.offClick(handler); bb.hide(); };
}

export function setMainButton({ text, onClick, color = '#FF4D5E', textColor = '#FFFFFF' } = {}) {
  const mb = wa()?.MainButton;
  if (!mb) return () => {};
  mb.setParams({ text, color, text_color: textColor, is_active: true, is_visible: true });
  mb.onClick(onClick);
  return () => { mb.offClick(onClick); mb.hide(); };
}

/* ── Шаринг ────────────────────────────────────────────────────── */

/**
 * Прямая ссылка на профиль.
 *
 * Тот же `startapp`, что и у приглашения в комнату, но с префиксом:
 * ник неотличим от названия раздела, и человек с ником `rooms` иначе
 * уводил бы к себе всех, кто нажал кнопку бота.
 */
export function profileLink(username) {
  const clean = String(username ?? '').replace(/^@/, '').trim();
  if (!clean) return null;
  if (ENV.telegramBot) {
    return `https://t.me/${ENV.telegramBot}/${ENV.telegramApp}?startapp=${profileStartParam(clean)}`;
  }
  const url = new URL(globalThis.location?.href ?? 'https://matchwatch.app');
  return `${url.origin}/@${clean}`;
}

/** Прямая ссылка-приглашение в комнату. */
export function roomInviteLink(code) {
  const normalized = normalizeRoomCode(code);
  if (!normalized) return null;
  if (ENV.telegramBot) {
    return `https://t.me/${ENV.telegramBot}/${ENV.telegramApp}?startapp=${normalized}`;
  }
  const url = new URL(globalThis.location?.href ?? 'https://matchwatch.app');
  url.search = `?room=${normalized}`;
  url.hash = '';
  return url.toString();
}

/**
 * Отправить приглашение/карточку мэтча в чат Telegram.
 * `shareURL` открывает нативный список чатов: получателю не нужно
 * заходить в приложение, чтобы увидеть превью.
 */
export function shareToTelegram({ url, text }) {
  const app = wa();
  try {
    if (app?.openTelegramLink) {
      const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text ?? '')}`;
      app.openTelegramLink(link);
      return true;
    }
    if (app?.shareURL) { app.shareURL(url, text); return true; }
  } catch (error) {
    trackError('Не удалось открыть шаринг Telegram', { module: MODULE.SHARE, error });
  }
  return false;
}

/** Инлайн-режим: пользователь выбирает чат, бот отправляет карточку с постером. */
export function shareViaInlineQuery(queryText, chatTypes = ['users', 'groups']) {
  const app = wa();
  try {
    if (app?.switchInlineQuery) { app.switchInlineQuery(queryText, chatTypes); return true; }
  } catch (error) {
    /*
     * Инлайн-режим включается у бота отдельно, и его отсутствие — не сбой:
     * ниже по стеку карточка уходит обычной ссылкой. Ошибкой это писать
     * нельзя, иначе в журнале тонут настоящие поломки.
     */
    trackBusiness(BIZ.OFFLINE_DEGRADED, {
      module: MODULE.SHARE,
      level: LEVEL.INFO,
      context: { missingFeature: 'switchInlineQuery', reason: error?.message ?? 'unavailable' },
    });
  }
  return false;
}

/** Сохранить изображение карточки мэтча в галерею (Bot API 8.0+). */
/**
 * Открывает счёт на оплату звёздами.
 *
 * Внутри Telegram это нативное окно клиента: показать его умеет только
 * он сам, у веба такого способа нет. Снаружи открываем ссылку — она
 * ведёт в Telegram, где оплата и продолжится.
 *
 * Ответ приходит одним из четырёх состояний, и `pending` среди них
 * не финальное: деньги ещё идут, доступ появится по вебхуку. Поэтому
 * вызывающему возвращаем именно статус, а не «получилось / не получилось».
 *
 * @returns {Promise<'paid'|'cancelled'|'failed'|'pending'|'external'>}
 */
export function openInvoice(url) {
  const app = wa();

  if (!app?.openInvoice) {
    reportSdkGap('openInvoice');
    openLink(url);
    return Promise.resolve('external');
  }

  return new Promise((resolve) => {
    try {
      app.openInvoice(url, (status) => resolve(status ?? 'failed'));
    } catch {
      // Клиент старше Bot API 6.1 — ссылка всё ещё рабочая.
      openLink(url);
      resolve('external');
    }
  });
}

export function downloadMatchImage(url, filename = 'matchwatch.png') {
  const app = wa();
  if (app?.downloadFile && versionAtLeast('8.0')) {
    try { app.downloadFile({ url, file_name: filename }); return true; } catch { /* fallthrough */ }
  }
  return false;
}

export function openLink(url) {
  const app = wa();
  if (app?.openLink) { app.openLink(url, { try_instant_view: false }); return; }
  globalThis.open?.(url, '_blank', 'noopener');
}

/**
 * Открывает ссылку ВНУТРИ Telegram — чат, бота, канал.
 *
 * Отличается от `openLink` тем, что не выкидывает человека в браузер:
 * `t.me`-адрес, открытый через внешний браузер, сначала показывает
 * страницу-заглушку «Open in Telegram» и только потом возвращает
 * обратно. Для ссылки на бота это два лишних экрана на ровном месте.
 */
export function openTelegramLink(url) {
  const app = wa();
  try {
    if (app?.openTelegramLink) { app.openTelegramLink(url); return true; }
  } catch { /* старый клиент — уходим в обычное открытие */ }
  openLink(url);
  return false;
}

/**
 * Попросить у человека разрешение писать ему в Telegram.
 *
 * Это правильный путь вместо ссылки на чат с ботом. Ссылка
 * `t.me/<bot>?start=` из Mini App работает плохо: `openTelegramLink`
 * сначала ЗАКРЫВАЕТ приложение, а бот, чей Mini App только что был
 * открыт, — это тот самый чат, из которого человек и пришёл. Клиент
 * просто возвращает его назад, и со стороны это выглядит как «выкинуло
 * в Telegram и ничего не произошло». Плюс сам Start всё равно надо
 * нажать руками — ссылка его не отправляет.
 *
 * `requestWriteAccess` показывает родное окно «разрешить боту писать
 * вам?»: одно касание, не выходя из приложения. Разрешение даёт ровно
 * то, что нам нужно, — право отправить сообщение, — и не требует ни
 * Start, ни перехода в чат.
 *
 * @returns {Promise<boolean>} разрешил ли человек
 */
export function requestWriteAccess() {
  const app = wa();

  return new Promise((resolve) => {
    /* Старый клиент метода не знает — там остаётся запасной путь. */
    if (!app?.requestWriteAccess) { resolve(false); return; }

    try {
      app.requestWriteAccess((granted) => resolve(Boolean(granted)));
    } catch (error) {
      trackError('Не удалось запросить право на сообщения', {
        module: MODULE.AUTH_TELEGRAM, level: LEVEL.WARNING, error,
      });
      resolve(false);
    }
  });
}

/** Подтверждение выхода — иначе пользователь случайно закроет комнату. */
export function enableClosingConfirmation(enabled) {
  const app = wa();
  try {
    if (enabled) app?.enableClosingConfirmation?.();
    else app?.disableClosingConfirmation?.();
  } catch { /* не критично */ }
}

export function reportSdkGap(feature) {
  trackBusiness(BIZ.OFFLINE_DEGRADED, {
    module: MODULE.TELEGRAM_SDK,
    level: LEVEL.INFO,
    context: { missingFeature: feature, version: wa()?.version ?? 'none' },
  });
}
