/**
 * POST /api/telegram/webhook — входящие сообщения бота.
 *
 * Telegram шлёт сюда каждое обновление. Проверка — по заголовку
 * `X-Telegram-Bot-Api-Secret-Token`, который задаётся при регистрации
 * вебхука: адрес эндпоинта публичный, и без сверки писать боту от имени
 * Telegram смог бы кто угодно.
 *
 * Обработчик почти всегда отвечает 200, даже когда внутри что-то
 * сломалось. Telegram повторяет неудачные доставки, и ошибка в разборе
 * одного сообщения иначе превращается в бесконечный поток одного и того
 * же обновления. Единственное исключение — неверный секрет: такому
 * запросу отвечать «принято» нельзя.
 */

import { withHandler, ApiError } from './http.js';
import { sbSelect, sbInsert, sbUpdate, hasServiceKey } from './supabaseAdmin.js';
import {
  sendMessage, openAppButton, answerInlineQuery, appLink, linkButton, miniAppUrl,
  callBot, navKeyboard, TEXTS,
} from './botApi.js';
import { DESTINATION, profileStartParam } from '../../shared/model/startParam.js';
import { logError, logMetric } from './telemetry.js';
import { creditPayment } from './billing.js';
import { BIZ, LEVEL, METRIC, MODULE } from '../../shared/telemetry/events.js';
import { timingSafeEqual } from 'node:crypto';

export const webhookHandler = withHandler({ methods: ['POST'], module: MODULE.BOT }, async ({ req, body }) => {
  assertFromTelegram(req);

  if (!hasServiceKey()) {
    throw new ApiError(503, 'bot_not_configured',
      'Бот недоступен: не задан SUPABASE_SERVICE_ROLE_KEY');
  }

  try {
    await handleUpdate(body ?? {});
  } catch (error) {
    // Разобрать не смогли — но подтверждаем приём, иначе Telegram
    // будет слать это же обновление по кругу.
    logError({
      message: 'bot: не удалось обработать обновление',
      module: MODULE.BOT,
      level: LEVEL.WARNING,
      error,
    });
  }

  return { handled: true };
});

/**
 * Секрет вебхука обязателен.
 *
 * Без переменной окружения эндпоинт закрывается, а не открывается:
 * забытая переменная не должна тихо превращать бота в открытый вход.
 */
function assertFromTelegram(req) {
  const expected = (process.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  if (!expected) {
    throw new ApiError(503, 'secret_not_configured',
      'Вебхук закрыт: не задан TELEGRAM_WEBHOOK_SECRET', { level: LEVEL.CRITICAL });
  }

  const provided = req.headers?.['x-telegram-bot-api-secret-token'] ?? '';
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError(401, 'unauthorized', 'Запрос не от Telegram', { level: LEVEL.WARNING });
  }
}

async function handleUpdate(update) {
  if (update.inline_query) {
    await onInlineQuery(update.inline_query);
    return;
  }

  /*
   * Предчек обязан получить ответ в течение десяти секунд, иначе
   * Telegram отменяет оплату сам и человек видит отказ на ровном месте.
   * Поэтому здесь нет ни одного обращения к базе: всё, что нужно было
   * проверить, проверено при выписке счёта.
   */
  if (update.pre_checkout_query) {
    await onPreCheckout(update.pre_checkout_query);
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message?.chat || message.chat.type !== 'private') return;

  if (message.successful_payment) {
    await onSuccessfulPayment(message);
    return;
  }

  const from = message.from ?? {};
  const chatId = message.chat.id;
  const telegramId = String(from.id ?? chatId);
  const text = String(message.text ?? '').trim();

  const [command, ...rest] = text.split(/\s+/);
  const payload = rest.join(' ');

  if (command === '/start') {
    await onStart({ telegramId, chatId, from, payload });
    return;
  }

  if (command === '/stop' || command === '/mute') {
    await setNotify(telegramId, false);
    await sendMessage(chatId, TEXTS.muted);
    return;
  }

  if (command === '/help') {
    await sendMessage(chatId, TEXTS.help, { keyboard: navMenu() });
    return;
  }

  if (command === '/menu') {
    await sendMessage(chatId, TEXTS.menu, { keyboard: navMenu() });
    return;
  }

  /*
   * Короткие команды на каждый раздел.
   *
   * Меню кнопками есть, но человек, который знает, куда идёт, набирает
   * «/vmeste» быстрее, чем ищет кнопку глазами. Названия русские
   * латиницей: Telegram не принимает кириллицу в командах.
   */
  const shortcut = SHORTCUTS[command];
  if (shortcut) {
    await sendMessage(chatId, shortcut.text, {
      keyboard: openAppButton(shortcut.button, { startParam: shortcut.to }),
    });
    return;
  }

  await sendMessage(chatId, TEXTS.fallback, { keyboard: openAppButton() });
}

/* ── Навигация ───────────────────────────────────────────────────── */

/**
 * Разделы, до которых бот довозит.
 *
 * Порядок — по частоте, а не по структуре приложения: лента первой,
 * потому что за ней приходят чаще всего, премиум последним, потому что
 * за ним не приходят вовсе — его открывают, когда уже что-то поняли.
 */
const navMenu = () => navKeyboard([
  { text: '🎬 Лента', to: DESTINATION.DECK },
  { text: '👀 Смотрим вместе', to: DESTINATION.ROOMS },
  { text: '🔖 Моё', to: DESTINATION.MINE },
  { text: '📚 Каталог', to: DESTINATION.COLLECTION },
  { text: '✨ Что нового', to: DESTINATION.NEWS },
  { text: '👑 Премиум', to: DESTINATION.PREMIUM },
]);

/** Команда → куда ведёт и что сказать по дороге. */
const SHORTCUTS = {
  '/kino': {
    to: DESTINATION.DECK,
    button: 'Открыть ленту',
    text: 'Лента ждёт. Свайп вправо — нравится, влево — мимо, вверх — уже смотрел.',
  },
  '/vmeste': {
    to: DESTINATION.ROOMS,
    button: 'Смотрим вместе',
    text: 'Создайте комнату и пришлите код второму — свайпать будете каждый со своего телефона.',
  },
  '/moe': {
    to: DESTINATION.MINE,
    button: 'Открыть «Моё»',
    text: 'Всё, про что решение уже принято: отложенное, просмотренное, оценки и мэтчи.',
  },
  '/new': {
    to: DESTINATION.NEWS,
    button: 'Что нового',
    text: 'Здесь мы пишем про каждое заметное обновление.',
  },
  '/premium': {
    to: DESTINATION.PREMIUM,
    button: 'Посмотреть премиум',
    text: 'Подписка снимает границы бесплатного тарифа. На время закрытого теста — бесплатно.',
  },
};

/* ── Оплата звёздами ─────────────────────────────────────────────── */

/**
 * Подтверждение перед списанием.
 *
 * Отвечаем «да» всегда. Отказывать здесь было бы правильно, если бы
 * товар мог кончиться или подорожать между выпиской счёта и оплатой, —
 * у подписки ни того, ни другого не бывает. А неотвеченный предчек
 * это отменённая оплата, то есть худший исход из возможных.
 */
async function onPreCheckout(query) {
  const { ok, description } = await callBot('answerPreCheckoutQuery', {
    pre_checkout_query_id: query.id,
    ok: true,
  });

  if (!ok) {
    logError({
      message: 'bot: не удалось подтвердить предчек оплаты',
      module: MODULE.BOT,
      level: LEVEL.CRITICAL,
      context: { description, biz: BIZ.PAYMENT_DECLINED },
    });
  }
}

/**
 * Деньги списаны — выдаём доступ.
 *
 * Пользователя берём из payload счёта, а не из отправителя сообщения:
 * счёт выписывался вошедшему в приложение человеку, и именно его
 * аккаунт должен получить премиум. Telegram-аккаунт и аккаунт
 * MatchWatch — не одно и то же, их связь может отсутствовать.
 *
 * Payload при этом пришёл от Telegram, а не от клиента, поэтому ему
 * можно верить: подделать его пользователь не может.
 */
async function onSuccessfulPayment(message) {
  const payment = message.successful_payment;
  const chatId = message.chat.id;

  let payload = null;
  try {
    payload = JSON.parse(payment.invoice_payload ?? '{}');
  } catch {
    payload = null;
  }

  const userId = payload?.userId;
  if (!userId) {
    logError({
      message: 'bot: оплата без пользователя в payload — доступ выдать некому',
      module: MODULE.BOT,
      level: LEVEL.CRITICAL,
      context: { chargeId: payment.telegram_payment_charge_id },
    });
    await sendMessage(chatId, TEXTS.paymentOrphan);
    return;
  }

  const { credited, subscription } = await creditPayment({
    userId,
    source: 'stars',
    amount: payment.total_amount ?? 0,
    currency: payment.currency ?? 'XTR',
    chargeId: payment.telegram_payment_charge_id,
    days: Number(payload.days) || undefined,
    payload: {
      provider_charge_id: payment.provider_payment_charge_id ?? null,
      telegram_user_id: String(message.from?.id ?? ''),
    },
  });

  if (!credited) {
    // Повторная доставка того же обновления — человеку писать не о чем.
    logMetric(METRIC.PREMIUM_PURCHASED, {
      userId, value: 0, context: { biz: BIZ.PAYMENT_DUPLICATE },
    });
    return;
  }

  logMetric(METRIC.PREMIUM_PURCHASED, {
    userId,
    value: payment.total_amount ?? 0,
    context: { currency: payment.currency ?? 'XTR' },
  });

  await sendMessage(chatId, TEXTS.paymentDone(subscription?.expires_at), {
    keyboard: openAppButton(),
  });
}

/**
 * `/start` — единственное место, где появляется право писать человеку.
 *
 * Telegram не даёт боту обратиться первым к тому, кто не нажимал Start,
 * поэтому строка в `telegram_chats` означает именно разрешение, а не
 * «мы его где-то видели». Повторный /start снимает и блокировку, и
 * прежний отказ от уведомлений: человек вернулся сам.
 */
async function onStart({ telegramId, chatId, from, payload }) {
  const userId = await linkedUserId(telegramId);

  await sbInsert('telegram_chats', [{
    telegram_id: telegramId,
    chat_id: chatId,
    user_id: userId,
    username: from.username ?? null,
    blocked_at: null,
    notify: true,
  }], { upsert: true, onConflict: 'telegram_id' });

  logMetric(METRIC.BOT_STARTED, {
    userId,
    context: { linked: Boolean(userId), invitedToRoom: Boolean(payload) },
  });

  if (!miniAppUrl()) {
    // Кнопки не будет, и это видно снаружи — честнее сказать прямо.
    logError({
      message: 'bot: не задан TELEGRAM_MINIAPP_URL — кнопка «Открыть» не показывается',
      module: MODULE.BOT,
      level: LEVEL.CRITICAL,
    });
  }

  const roomCode = parseRoomPayload(payload);
  if (roomCode) {
    await sendMessage(chatId, TEXTS.startWithRoom(roomCode), {
      // Голый код, как в `?startapp=CODE`: приложение читает start_param
      // одной функцией, и второй формат ей знать незачем.
      keyboard: openAppButton(`Войти в комнату ${roomCode}`, { startParam: roomCode }),
    });
    return;
  }

  await sendMessage(chatId, TEXTS.start, { keyboard: openAppButton() });
}

/** `/start room_23356` — приглашение в конкретную комнату. */
export function parseRoomPayload(payload) {
  const match = /^room[_-]?(\d{5})$/i.exec(String(payload ?? '').trim());
  return match ? match[1] : null;
}

async function linkedUserId(telegramId) {
  const rows = await sbSelect('identities', {
    select: 'user_id',
    provider: 'eq.telegram',
    external_key: `eq.${telegramId}`,
    limit: 1,
  });
  return rows?.[0]?.user_id ?? null;
}

async function setNotify(telegramId, notify) {
  await sbUpdate('telegram_chats', { telegram_id: `eq.${telegramId}` }, { notify });
}

/* ────────────────────────────────────────────────────────────────
   Инлайн-режим: карточка, которую человек отправляет сам
   ──────────────────────────────────────────────────────────────── */

/**
 * Приложение зовёт `switchInlineQuery('match <titleId>')` или
 * `switchInlineQuery('room <code>')`, Telegram открывает список чатов,
 * и в выбранный чат уходит настоящая карточка с постером — а не голая
 * ссылка, из которой непонятно, о каком фильме речь.
 *
 * Отвечать обязательно, даже когда сказать нечего: без ответа Telegram
 * показывает бесконечную загрузку, и это выглядит как поломка.
 */
async function onInlineQuery(query) {
  const text = String(query.query ?? '').trim();
  const [kind, ...rest] = text.split(/\s+/);
  const argument = rest.join(' ').trim();

  let results = [];

  if (kind === 'match' && argument) {
    results = await matchResult(argument);
  } else if (kind === 'room') {
    const code = /^\d{5}$/.test(argument) ? argument : null;
    if (code) results = roomResult(code);
  } else if (kind === 'profile' && argument) {
    results = profileResult(argument);
  }

  // Пустой запрос и всё непонятное сводятся к карточке приложения:
  // человек уже выбрал чат, и остаться ни с чем — худший исход.
  if (!results.length) results = appResult();

  await answerInlineQuery(query.id, results);
}

async function matchResult(titleId) {
  const rows = await sbSelect('catalog_titles', {
    select: 'id,data',
    id: `eq.${titleId}`,
    limit: 1,
  });

  const title = rows?.[0]?.data;
  // Постер обязателен: без него это не фотокарточка, а тот же голый текст.
  if (!title?.title || !title?.poster) return [];

  const link = appLink();

  return [{
    type: 'photo',
    id: `match:${titleId}`.slice(0, 64),
    photo_url: title.poster,
    thumbnail_url: title.posterSmall ?? title.poster,
    title: `Мэтч: ${title.title}`,
    description: 'Отправить карточку в чат',
    caption: TEXTS.inline.match(title.title, title.year),
    parse_mode: 'HTML',
    ...(linkButton('Открыть MatchWatch', link) ? { reply_markup: linkButton('Открыть MatchWatch', link) } : {}),
  }];
}

/**
 * Карточка профиля для отправки в чат.
 *
 * `article`, а не `photo`: аватар есть не у всех, и половина отправок
 * молча превращалась бы в пустоту. Текст с ником работает всегда.
 */
export function profileResult(rawUsername) {
  const username = String(rawUsername).replace(/^@/, '').trim().slice(0, 32);
  if (!/^[a-z0-9_]{3,32}$/i.test(username)) return [];

  const link = appLink(profileStartParam(username));

  return [{
    type: 'article',
    id: `profile:${username}`.slice(0, 64),
    title: `Профиль @${username}`,
    description: 'Показать, что вы смотрите',
    input_message_content: {
      message_text: TEXTS.inline.profile(username),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
    ...(linkButton('Открыть профиль', link)
      ? { reply_markup: linkButton('Открыть профиль', link) }
      : {}),
  }];
}

export function roomResult(code) {
  const link = appLink(code);

  return [{
    type: 'article',
    id: `room:${code}`,
    title: `Комната ${code}`,
    description: 'Позвать выбирать кино вместе',
    input_message_content: {
      message_text: TEXTS.inline.room(code),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
    ...(linkButton(`Войти в комнату ${code}`, link)
      ? { reply_markup: linkButton(`Войти в комнату ${code}`, link) }
      : {}),
  }];
}

function appResult() {
  const link = appLink();

  return [{
    type: 'article',
    id: 'app',
    title: 'MatchWatch',
    description: 'Выбирать кино вдвоём',
    input_message_content: {
      message_text: TEXTS.inline.app,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
    ...(linkButton('Открыть MatchWatch', link)
      ? { reply_markup: linkButton('Открыть MatchWatch', link) }
      : {}),
  }];
}
