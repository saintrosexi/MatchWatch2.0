/**
 * Клиент Telegram Bot API и тексты бота.
 *
 * Отдельно от `telegram.js`: тот проверяет подпись входящего initData,
 * этот — разговаривает от имени бота. Общий у них только токен.
 *
 * Тон один на все сообщения: дружелюбно, но без панибратства. Бот
 * помогает открыть приложение и приносит новости, а собеседником
 * не притворяется — на любой свободный текст отвечает одинаково.
 */

import { botToken } from './telegram.js';

const API = 'https://api.telegram.org';

/** Адрес мини-приложения. Кнопка без него бессмысленна, поэтому проверяем. */
export const miniAppUrl = () => (process.env.TELEGRAM_MINIAPP_URL
  ?? process.env.PUBLIC_APP_URL
  ?? '').trim().replace(/\/$/, '') || null;

/**
 * Вызов метода Bot API.
 *
 * Возвращает `{ ok, result, errorCode, description }` вместо исключения:
 * рассылка обязана отличать «человек заблокировал бота» от «сеть легла».
 * Первое — окончательный ответ, повторять его нельзя; второе — повод
 * попробовать ещё раз.
 */
export async function callBot(method, payload) {
  const token = botToken();
  if (!token) return { ok: false, errorCode: 0, description: 'TELEGRAM_BOT_TOKEN не задан' };

  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);

    if (data?.ok) return { ok: true, result: data.result };
    return {
      ok: false,
      errorCode: data?.error_code ?? res.status,
      description: data?.description ?? `HTTP ${res.status}`,
    };
  } catch (error) {
    return { ok: false, errorCode: 0, description: error?.message ?? 'сетевая ошибка' };
  }
}

/**
 * Телеграм считает эти коды окончательными: человек заблокировал бота,
 * удалил аккаунт или чат больше не существует. Повторять такую отправку
 * нельзя — очередь иначе будет вечно долбиться в стену.
 */
const FATAL_DESCRIPTIONS = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  'bot can\'t initiate conversation',
];

export function isFatalSendError({ errorCode, description }) {
  if (errorCode === 403) return true;
  const text = String(description ?? '').toLowerCase();
  return FATAL_DESCRIPTIONS.some((known) => text.includes(known));
}

/** Кнопка, открывающая мини-приложение. Без адреса — без кнопки. */
export function openAppButton(label = 'Открыть MatchWatch', { startParam } = {}) {
  const base = miniAppUrl();
  if (!base) return null;
  const url = startParam ? `${base}?tgWebAppStartParam=${encodeURIComponent(startParam)}` : base;
  return { inline_keyboard: [[{ text: label, web_app: { url } }]] };
}

/**
 * Клавиатура-навигатор: несколько кнопок, каждая открывает свой экран.
 *
 * Бот не пересказывает приложение и не пытается быть собеседником —
 * он довозит до нужного места в один тап. Это единственная работа,
 * которую он делает лучше самого приложения: человек уже в Telegram,
 * и до нужного экрана ему иначе три касания и поиск глазами.
 *
 * По две кнопки в ряд: на телефоне ряд из трёх обрезает подписи.
 */
export function navKeyboard(destinations) {
  const base = miniAppUrl();
  if (!base) return null;

  const buttons = destinations.map(({ text, to }) => ({
    text,
    web_app: { url: to ? `${base}?tgWebAppStartParam=${encodeURIComponent(to)}` : base },
  }));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

export function sendMessage(chatId, text, { keyboard = null, preview = false } = {}) {
  return callBot('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: !preview },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

/**
 * Ссылка на мини-приложение внутри Telegram.
 *
 * Кнопка `web_app` в инлайн-результатах не поддерживается: результат
 * отправляет пользователь, а не бот, и права на открытие приложения
 * у такого сообщения нет. Поэтому обычная ссылка `t.me`, которая
 * открывает то же самое.
 */
export function appLink(startParam) {
  const bot = (process.env.VITE_TELEGRAM_BOT_USERNAME ?? process.env.TELEGRAM_BOT_USERNAME ?? '')
    .trim().replace(/^@/, '');
  if (!bot) return miniAppUrl();

  const app = (process.env.VITE_TELEGRAM_APP_NAME ?? process.env.TELEGRAM_APP_NAME ?? 'app').trim();
  const base = `https://t.me/${bot}/${app}`;
  return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : base;
}

/** Кнопка-ссылка под инлайн-карточкой. */
export const linkButton = (text, url) => (url
  ? { inline_keyboard: [[{ text, url }]] }
  : undefined);

export function answerInlineQuery(id, results, { cacheTime = 60 } = {}) {
  return callBot('answerInlineQuery', {
    inline_query_id: id,
    results,
    cache_time: cacheTime,
    is_personal: true,
  });
}

/** Экранирование под parse_mode: HTML — имена приходят от людей. */
export const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/* ────────────────────────────────────────────────────────────────
   Тексты
   ──────────────────────────────────────────────────────────────── */

export const TEXTS = {
  start: 'Привет! Это <b>MatchWatch</b> — здесь выбирают кино вдвоём.\n\n'
    + 'Каждый свайпает карточки со своего телефона, а приложение показывает то, '
    + 'на чём вы сошлись. Спорить о том, что включить, больше не придётся.\n\n'
    + 'Нажмите кнопку ниже, чтобы начать.',

  startWithRoom: (code) => `Вас зовут в комнату <b>${esc(code)}</b>.\n\n`
    + 'Откройте приложение — попадёте сразу в неё, и можно свайпать.',

  help: '<b>Что я умею</b>\n\n'
    + '• Довожу до нужного экрана в один тап — /menu.\n'
    + '• Пишу, когда вас позвали в друзья.\n'
    + '• Раз в неделю напоминаю про то, что вы отложили и до сих пор не посмотрели.\n\n'
    + '<b>Команды</b>\n'
    + '/menu — все разделы кнопками\n'
    + '/kino — лента: свайпать кино\n'
    + '/vmeste — смотрим вместе: комната на двоих\n'
    + '/moe — списки: отложенное, просмотренное, оценки\n'
    + '/new — что нового в приложении\n'
    + '/stop — выключить уведомления, /start — включить обратно\n\n'
    + 'Само кино подбирается в приложении, а не в переписке: '
    + 'здесь нет ни свайпов, ни комнат — только дорога до них.',

  /**
   * Меню навигации.
   *
   * Текст короткий намеренно: работают здесь кнопки, а не абзац над ними.
   * Длинное вступление перед списком кнопок читают ровно один раз.
   */
  menu: '<b>Куда идём?</b>\n\nЛюбая кнопка открывает приложение сразу на нужном экране.',

  fallback: 'Кино я подбираю в приложении, а не в переписке — открывайте и свайпайте.\n\n'
    + '/help — что я умею.',

  muted: 'Уведомления выключил. Заявки в друзья и напоминания больше не придут — '
    + 'всё это по-прежнему видно в приложении.\n\n/start — включить обратно.',

  unmuted: 'Уведомления снова включены.',

  friendRequest: (name) => `<b>${esc(name)}</b> хочет добавить вас в друзья.\n\n`
    + 'Заявка ждёт в приложении, во вкладке «Я».',

  friendAccepted: (name) => `<b>${esc(name)}</b> принял вашу заявку — теперь вы друзья.\n\n`
    + 'Создайте комнату и пришлите код — свайпать будете каждый '
    + 'со своего телефона, а приложение покажет, на чём вы сошлись.',

  /**
   * Приглашение в комнату от друга.
   *
   * Код назван в тексте, хотя кнопка и так ведёт внутрь: сообщение
   * могут прочитать с компьютера, где кнопка не открывается, — тогда
   * код остаётся единственным способом войти.
   */
  roomInvite: (name, code) => `<b>${esc(name)}</b> зовёт выбрать кино вместе.\n\n`
    + `Комната <b>${esc(code)}</b> — свайпаете каждый со своего телефона, `
    + 'а приложение покажет, на чём вы сошлись.',

  /* ── Оплата ── */

  /**
   * Дата окончания в сообщении обязательна.
   *
   * «Спасибо за оплату» не отвечает на единственный вопрос, который
   * у человека в этот момент есть: до какого числа у него оплачено.
   */
  paymentDone: (expiresAt) => {
    const until = expiresAt
      ? new Date(expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : null;
    return '<b>Премиум активен.</b> Спасибо — это правда помогает.\n\n'
      + (until ? `Оплачено до ${esc(until)}.` : 'Доступ открыт.')
      + '\n\nОформление профиля и всё остальное уже доступно в приложении.';
  },

  /**
   * Оплата дошла, а к какому аккаунту её отнести — непонятно.
   *
   * Молчать здесь нельзя: деньги списаны. Просим написать, потому что
   * вернуть звёзды мы можем, а угадать владельца — нет.
   */
  paymentOrphan: 'Оплата прошла, но привязать её к аккаунту не удалось — '
    + 'напишите нам, разберёмся и вернём или активируем вручную.',

  /**
   * Напоминание про отложенное.
   *
   * Названия приводим полностью, а не «у вас 7 фильмов»: число ни о чём
   * не напоминает, а «Дюна» — напоминает.
   */
  watchlistDigest: (titles, total) => {
    const list = titles.filter(Boolean).map((t) => `• ${esc(t)}`).join('\n');
    const tail = total > titles.length ? `\n\n…и ещё ${total - titles.length}.` : '';
    return 'Вы откладывали кино и пока до него не дошли:\n\n' + list + tail
      + '\n\nВечер свободен?';
  },

  /* ── Карточки, которые человек отправляет в чат ── */

  inline: {
    match: (title, year) => `<b>Мэтч!</b> Мы сошлись на фильме «${esc(title)}»`
      + (year ? ` (${year})` : '')
      + '.\n\nВыбирали в MatchWatch — там каждый свайпает со своего телефона, '
      + 'а приложение показывает общее.',

    room: (code) => `Собираемся выбирать кино. Комната <b>${esc(code)}</b>.\n\n`
      + 'Заходи: свайпаешь со своего телефона, а MatchWatch покажет, '
      + 'на чём мы сошлись.',

    /*
     * Про пересечение вкусов сказано прямо: это единственная причина
     * открыть чужой профиль, и она же — причина завести свой.
     */
    profile: (username) => `Мой профиль в MatchWatch — <b>@${esc(username)}</b>.\n\n`
      + 'Там видно, что я смотрю и что люблю. Открой — сразу покажет, '
      + 'сколько фильмов нравится нам обоим.',

    app: 'Выбираем кино вдвоём: каждый свайпает со своего телефона, '
      + 'а <b>MatchWatch</b> показывает то, на чём вы сошлись.',
  },
};
