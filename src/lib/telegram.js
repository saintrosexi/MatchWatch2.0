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
 * Отправить подготовленное сообщение из родного окна выбора чата.
 *
 * Это единственный способ поделиться, при котором Mini App НЕ
 * закрывается. `switchInlineQuery` окно тоже открывает, но по
 * устройству уходит в выбранный чат — он вставляет туда запрос
 * и обязан этот чат показать; приложение при этом закрывается,
 * и это его работа, а не сбой.
 *
 * `shareMessage` появился в Bot API 8.0 и сделан ровно для этого:
 * окно рисуется поверх, сообщение уходит, человек остаётся там же,
 * где был. Сообщение готовится заранее на сервере — см.
 * `/api/telegram/prepare-share`.
 *
 * @returns {Promise<boolean>} отправлено ли; `false` — метода нет
 *   или человек закрыл окно, не выбрав чат.
 */
export function sharePreparedMessage(preparedId) {
  const app = wa();

  return new Promise((resolve) => {
    if (!preparedId || !app?.shareMessage || !(app.isVersionAtLeast?.('8.0'))) {
      resolve(false);
      return;
    }

    try {
      app.shareMessage(preparedId, (sent) => resolve(Boolean(sent)));
    } catch (error) {
      trackBusiness(BIZ.OFFLINE_DEGRADED, {
        module: MODULE.SHARE,
        level: LEVEL.INFO,
        context: {
          missingFeature: 'shareMessage',
          reason: error?.message ?? 'unavailable',
          tgVersion: app.version ?? null,
        },
      });
      resolve(false);
    }
  });
}

/**
 * Инлайн-режим: родной выбор чата с карточкой от бота.
 *
 * Уступает и `sharePreparedMessage`, и `shareViaTelegramPicker` в одном
 * важном: по устройству он ОБЯЗАН уйти в выбранный чат и вставить там
 * запрос, поэтому приложение закрывается. Держим его третьим — ради
 * карточки с постером и кнопкой входа, которой у голой ссылки нет.
 *
 * Пробуем тремя заходами, от лучшего к худшему, потому что Telegram
 * отвергает вызов по разным причинам и молча:
 *
 *   1. Люди и группы — как задумано.
 *   2. Только люди. Тип чата, который бот обслуживать не может,
 *      роняет ВЕСЬ вызов, а не отсекает лишнее; в комнату всё равно
 *      зовут человека, так что потеря невелика.
 *   3. Без указания типов вовсе — самая старая форма, её понимают
 *      клиенты, не знающие про выбор чата.
 *
 * Версию проверяем заранее: на старом клиенте вызов кидает исключение,
 * и три попытки подряд — это три исключения на ровном месте.
 */
export function shareViaInlineQuery(queryText, chatTypes = ['users', 'groups']) {
  const app = wa();
  if (!app?.switchInlineQuery) return false;

  /* Выбор чата появился в Bot API 6.7; ниже — только старая форма. */
  const canChooseChat = app.isVersionAtLeast?.('6.7') ?? false;
  const attempts = canChooseChat
    ? [chatTypes, ['users'], undefined]
    : [undefined];

  const failures = [];

  for (const types of attempts) {
    try {
      if (types) app.switchInlineQuery(queryText, types);
      else app.switchInlineQuery(queryText);
      return true;
    } catch (error) {
      failures.push(`${types ? types.join('+') : 'без типов'}: ${error?.message ?? 'unavailable'}`);
    }
  }

  /*
   * Не сбой продукта, а отказ платформы, но знать о нём надо: без него
   * приглашение уходит запасным путём, и разговор про «поделиться стало
   * хуже» снова начинается с догадок.
   */
  trackBusiness(BIZ.OFFLINE_DEGRADED, {
    module: MODULE.SHARE,
    level: LEVEL.INFO,
    context: {
      missingFeature: 'switchInlineQuery',
      reason: failures.join(' | ').slice(0, 300),
      tgVersion: app.version ?? null,
      tgPlatform: app.platform ?? null,
      /* Запущено ли приложение из чата: без чата выбирать не из чего. */
      hasChatInstance: Boolean(app.initDataUnsafe?.chat_instance),
      canChooseChat,
    },
  });

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
 * Останется ли Mini App открытым при переходе по `t.me`-ссылке.
 *
 * ЭТО ГЛАВНАЯ РАЗВИЛКА ВСЕГО ФАЙЛА, и раньше она была решена неверно.
 *
 * До Bot API 7.0 `openTelegramLink` действительно ЗАКРЫВАЛ приложение —
 * отсюда весь обходной аппарат вокруг: ссылку присылал бот сообщением,
 * приглашение копировалось в буфер, «где купить звёзды» вело не в чат,
 * а в уведомление о том, что ссылка где-то лежит. С Bot API 7.0
 * поведение ПРОТИВОПОЛОЖНОЕ, и документация говорит это прямо:
 *
 *   «The Mini App will not be closed after this method is called.
 *    Up to Bot API 7.0 The Mini App will be closed after this method
 *    is called.»
 *
 * На таком клиенте переход выглядит как у любого нормального кошелька
 * или сервиса в Telegram: приложение сворачивается в плашку внизу,
 * чат или канал открывается поверх, возврат — одно касание. Именно
 * это и нужно: не «бот пришлёт вам ссылку», а «нажал — ты там».
 *
 * Поэтому версия проверяется не ради перестраховки. Это выбор между
 * двумя разными продуктами: на 7.0+ прямая ссылка — ЛУЧШИЙ путь,
 * на клиентах старше — худший, и там обходные пути остаются нужны.
 */
export const keepsAppOpenOnTelegramLink = () => Boolean(wa()) && versionAtLeast('7.0');

/**
 * Открывает ссылку ВНУТРИ Telegram — чат, бота, канал.
 *
 * Отличается от `openLink` тем, что не выкидывает человека в браузер:
 * `t.me`-адрес, открытый через внешний браузер, сначала показывает
 * страницу-заглушку «Open in Telegram» и только потом возвращает
 * обратно. Для ссылки на бота это два лишних экрана на ровном месте.
 *
 * Возвращает не «получилось / не получилось», а ЧТО ПРОИЗОШЛО
 * С ПРИЛОЖЕНИЕМ, потому что от этого зависит текст, который человек
 * увидит следом:
 *
 *   'kept'     — клиент 7.0+: чат открылся поверх, приложение свёрнуто
 *                и ждёт возврата. Извиняться и объяснять нечего.
 *   'closed'   — клиент старше 7.0: ссылка открылась, но Mini App
 *                закрылся. Об этом человека надо предупредить ЗАРАНЕЕ,
 *                а не ставить перед фактом.
 *   'external' — SDK нет вовсе (обычный браузер): ушли во внешнюю
 *                вкладку, приложение осталось на месте.
 *
 * @returns {'kept'|'closed'|'external'}
 */
export function openTelegramLink(url) {
  const app = wa();
  try {
    if (app?.openTelegramLink) {
      const kept = keepsAppOpenOnTelegramLink();
      app.openTelegramLink(url);
      return kept ? 'kept' : 'closed';
    }
  } catch { /* старый клиент — уходим в обычное открытие */ }
  openLink(url);
  return 'external';
}

/**
 * Родное окно «Переслать» Telegram — поверх приложения.
 *
 * `t.me/share/url` — тот же выбор чата, который открывает кнопка
 * «поделиться» в самом Telegram: все чаты, поиск, несколько получателей
 * сразу. На клиентах 7.0+ он рисуется ПОВЕРХ Mini App и приложение
 * не закрывает.
 *
 * Чем он лучше того, что было. `switchInlineQuery` тоже показывает
 * родное окно, но по устройству ОБЯЗАН уйти в выбранный чат и вставить
 * там запрос — приложение при этом закрывается, и это его работа,
 * а не сбой. Копия ссылки в буфер не показывает вообще ничего.
 *
 * Чем он хуже `shareMessage` (Bot API 8.0): уходит голая ссылка
 * с подписью, а не карточка с постером и кнопкой входа. Поэтому
 * в цепочке он стоит ВТОРЫМ — после подготовленного сообщения,
 * но раньше всего остального.
 *
 * @returns {'kept'|'closed'|'external'|false} `false` — не в Telegram
 */
export function shareViaTelegramPicker({ url, text } = {}) {
  if (!url || !wa()) return false;

  /*
   * Кодируем вручную, а не через `URLSearchParams`: тот превращает
   * пробелы в «+», и подпись к ссылке приезжает получателю склеенной
   * плюсами. `encodeURIComponent` даёт `%20`, который клиент разбирает
   * как пробел везде.
   */
  const query = `url=${encodeURIComponent(url)}`
    + (text ? `&text=${encodeURIComponent(text)}` : '');

  return openTelegramLink(`https://t.me/share/url?${query}`);
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
