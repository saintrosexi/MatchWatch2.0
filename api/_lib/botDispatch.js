/**
 * POST /api/telegram/dispatch — разбор очереди уведомлений.
 *
 * Зовётся самой базой через pg_net сразу после записи в очередь, и ещё
 * раз в десять минут по расписанию — на случай, если тот вызов не дошёл.
 * Обработчик идемпотентен: разобранная строка помечается и второй раз
 * не отправляется.
 *
 * Своя очередь вместо прямой отправки из места события нужна ровно для
 * одного: заявка в друзья обязана состояться и тогда, когда Telegram
 * недоступен. Разделив запись и доставку, вторую можно повторить,
 * не трогая первую.
 */

import { withHandler, ApiError } from './http.js';
import { sbSelect, sbUpdate, hasServiceKey } from './supabaseAdmin.js';
import { sendMessage, openAppButton, isFatalSendError, TEXTS } from './botApi.js';
import { logError, logMetric } from './telemetry.js';
import { LEVEL, METRIC, MODULE } from '../../shared/telemetry/events.js';
import { DESTINATION } from '../../shared/model/startParam.js';
import { timingSafeEqual } from 'node:crypto';

/** Сколько раз пробуем доставить, прежде чем сдаться. */
const MAX_ATTEMPTS = 5;
/** Потолок на один заход: серверлес-функция ограничена по времени. */
const BATCH = 40;

export const dispatchHandler = withHandler({ methods: ['POST', 'GET'], module: MODULE.BOT }, async ({ req, query }) => {
  assertInternalCaller(req, query);

  if (!hasServiceKey()) {
    throw new ApiError(503, 'bot_not_configured',
      'Рассылка недоступна: не задан SUPABASE_SERVICE_ROLE_KEY');
  }

  const pending = await sbSelect('notifications_outbox', {
    select: 'id,user_id,kind,payload,attempts',
    sent_at: 'is.null',
    attempts: `lt.${MAX_ATTEMPTS}`,
    order: 'created_at.asc',
    limit: BATCH,
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of pending ?? []) {
    const outcome = await deliver(row);
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'skipped') skipped += 1;
    else failed += 1;
  }

  if (sent > 0) logMetric(METRIC.BOT_NOTIFIED, { value: sent });

  return { pending: pending?.length ?? 0, sent, skipped, failed };
});

/**
 * Эндпоинт зовётся только из базы. Секрет обязателен: без переменной
 * окружения он закрывается, а не открывается — иначе забытая настройка
 * тихо отдаёт рассылку кому угодно.
 */
function assertInternalCaller(req, query) {
  const expected = (process.env.BOT_DISPATCH_SECRET ?? '').trim();
  if (!expected) {
    throw new ApiError(503, 'secret_not_configured',
      'Рассылка закрыта: не задан BOT_DISPATCH_SECRET', { level: LEVEL.CRITICAL });
  }

  const provided = req.headers?.['x-bot-dispatch-secret']
    ?? req.headers?.authorization?.replace(/^Bearer\s+/i, '')
    ?? query?.get?.('token')
    ?? '';

  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError(401, 'unauthorized', 'Неверный секрет рассылки', { level: LEVEL.WARNING });
  }
}

/**
 * @returns {Promise<'sent'|'skipped'|'failed'>}
 *   sent — сообщение ушло;
 *   skipped — писать некому или незачем, строка закрыта навсегда;
 *   failed — попробуем ещё раз позже.
 */
async function deliver(row) {
  const chat = await chatFor(row.user_id);

  if (!chat) {
    // Человек не нажимал Start, выключил уведомления или заблокировал
    // бота. Это окончательный ответ, а не сбой: повторять нечего.
    await close(row.id, 'писать некому: нет активного чата с ботом');
    return 'skipped';
  }

  const message = await render(row);
  if (!message) {
    await close(row.id, `неизвестный тип уведомления: ${row.kind}`);
    logError({
      message: `bot: неизвестный тип уведомления «${row.kind}»`,
      module: MODULE.BOT,
      level: LEVEL.ERROR,
    });
    return 'skipped';
  }

  const result = await sendMessage(chat.chat_id, message.text, { keyboard: message.keyboard });

  if (result.ok) {
    await close(row.id, null);
    return 'sent';
  }

  if (isFatalSendError(result)) {
    // Заблокировавшему больше не стучимся — ни сейчас, ни впредь.
    await sbUpdate('telegram_chats', { telegram_id: `eq.${chat.telegram_id}` },
      { blocked_at: new Date().toISOString() });
    await close(row.id, `отказ Telegram: ${result.description}`);
    return 'skipped';
  }

  await sbUpdate('notifications_outbox', { id: `eq.${row.id}` }, {
    attempts: (row.attempts ?? 0) + 1,
    last_error: String(result.description ?? '').slice(0, 500),
  });
  return 'failed';
}

/** Помечает строку разобранной. `last_error` объясняет, почему молча. */
const close = (id, reason) => sbUpdate('notifications_outbox', { id: `eq.${id}` }, {
  sent_at: new Date().toISOString(),
  ...(reason ? { last_error: reason.slice(0, 500) } : {}),
});

async function chatFor(userId) {
  const rows = await sbSelect('telegram_chats', {
    select: 'telegram_id,chat_id',
    user_id: `eq.${userId}`,
    notify: 'is.true',
    blocked_at: 'is.null',
    limit: 1,
  });
  return rows?.[0] ?? null;
}

async function displayName(userId) {
  if (!userId) return 'Кто-то';
  const rows = await sbSelect('profiles', { select: 'display_name,username', id: `eq.${userId}`, limit: 1 });
  return rows?.[0]?.display_name || rows?.[0]?.username || 'Кто-то';
}

async function render(row) {
  const payload = row.payload ?? {};

  if (row.kind === 'friend_request') {
    return {
      text: TEXTS.friendRequest(await displayName(payload.from)),
      keyboard: openAppButton('Посмотреть заявку'),
    };
  }

  if (row.kind === 'friend_accepted') {
    /*
     * Кнопка ведёт СРАЗУ в комнаты, а не просто открывает приложение.
     *
     * «Теперь вы друзья» без следующего шага не меняет ничего: человек
     * закрывает сообщение, и новый друг остаётся строкой в списке.
     * Момент, когда позвать смотреть уместнее всего, — именно этот.
     */
    return {
      text: TEXTS.friendAccepted(await displayName(payload.friend)),
      keyboard: openAppButton('Позвать смотреть кино', { startParam: DESTINATION.ROOMS }),
    };
  }

  if (row.kind === 'room_invite') {
    const code = String(payload.code ?? '').trim();
    if (!code) return null;
    /*
     * Кнопка ведёт СРАЗУ в комнату по коду — вводить его руками
     * не нужно. Ради этого приглашение изнутри приложения и делалось:
     * ссылку и так можно переслать, а тут зовут конкретного человека.
     */
    return {
      text: TEXTS.roomInvite(await displayName(payload.from), code),
      keyboard: openAppButton(`Войти в комнату ${code}`, { startParam: code }),
    };
  }

  if (row.kind === 'watchlist_digest') {
    const titles = Array.isArray(payload.titles) ? payload.titles : [];
    if (!titles.length) return null;
    return {
      text: TEXTS.watchlistDigest(titles, Number(payload.items ?? titles.length)),
      keyboard: openAppButton('Открыть «Буду смотреть»'),
    };
  }

  if (row.kind === 'feedback') {
    /*
     * Текст отзыва читаем из таблицы, а не из очереди: в очереди лежит
     * только ссылка на него. Одна копия — значит, письмо и дашборд
     * не могут показать разное.
     */
    const feedback = await feedbackById(payload.feedback);
    if (!feedback?.body) return null;

    const author = await profileOf(payload.from);
    const context = feedback.context ?? {};

    return {
      text: TEXTS.feedbackReceived({
        name: author?.display_name || author?.username || 'Аноним',
        username: author?.username ?? null,
        body: feedback.body,
        screen: context.screen ?? null,
        release: context.release ?? null,
      }),
      keyboard: openAppButton('Открыть дашборд'),
    };
  }

  return null;
}

/** Один отзыв целиком — по идентификатору из очереди. */
async function feedbackById(id) {
  if (!id) return null;
  const rows = await sbSelect('feedback', {
    select: 'body,context', id: `eq.${id}`, limit: 1,
  });
  return rows?.[0] ?? null;
}

/** Имя и ник автора — чтобы владелец мог ответить человеку лично. */
async function profileOf(userId) {
  if (!userId) return null;
  const rows = await sbSelect('profiles', {
    select: 'display_name,username', id: `eq.${userId}`, limit: 1,
  });
  return rows?.[0] ?? null;
}
