/**
 * Вход через Telegram Mini App.
 *
 * POST /api/auth/telegram { initData } — единственное место, где
 * Telegram-пользователь превращается в сессию. Порядок такой:
 *
 *   1. Проверяем подпись initData секретом бота. Без этой проверки любой
 *      может подставить чужой telegram_id — подделать тело запроса ничего
 *      не стоит.
 *   2. Ищем, к какому аккаунту этот telegram_id уже привязан (таблица
 *      identities). Привязка важнее всего остального: если пользователь
 *      прицепил Telegram к своему email-аккаунту, войти он должен именно
 *      в него, а не в отдельный «телеграмный».
 *   3. Выдаём одноразовый token_hash, который клиент меняет на сессию
 *      через verifyOtp. Пароля у Telegram-аккаунта нет вовсе.
 *
 * Запасной режим (`mode: 'password'`) работает без SUPABASE_SERVICE_ROLE_KEY:
 * учётные данные выводятся детерминированно из telegram_id секретом бота.
 * Он проще в настройке, но привязка к существующему аккаунту в нём
 * невозможна — некому связать telegram_id с чужим user_id.
 *
 * GET /api/auth/telegram — диагностика конфигурации. Секретов не отдаёт:
 * только id и юзернейм бота (публичные) и факт наличия ключей. Нужна,
 * чтобы отличить «токен не тот» от «токен не задан» без чтения логов.
 */

import { createHmac } from 'node:crypto';
import { withHandler, badRequest, ApiError } from '../_lib/http.js';
import { validateInitData, describeBot, botToken as readBotToken, hasBotToken } from '../_lib/telegram.js';
import { hasServiceKey, authAdmin } from '../_lib/supabaseAdmin.js';
import { resolveUser, PROVIDER, telegramEmail, usernameFromTelegram } from '../_lib/identity.js';
import { logMetric } from '../_lib/telemetry.js';
import { METRIC, MODULE } from '../../shared/telemetry/events.js';
import { normalizeRoomCode } from '../../shared/model/roomCode.js';

export { telegramEmail };

function derivePassword(telegramId, botToken) {
  return createHmac('sha256', botToken)
    .update(`mw-auth:${telegramId}`)
    .digest('base64url')
    .slice(0, 40);
}

const displayNameOf = (user) =>
  [user.firstName, user.lastName].filter(Boolean).join(' ')
  || user.username
  || 'Зритель';

export default withHandler({ methods: ['GET', 'POST'], module: MODULE.AUTH_TELEGRAM }, async ({ req, body }) => {
  if (req.method === 'GET') return diagnostics();

  const initData = body?.initData;
  if (!initData) throw badRequest('initdata_required', 'Не передан initData');

  const botToken = readBotToken();
  if (!botToken) {
    throw new ApiError(503, 'telegram_not_configured',
      'Вход через Telegram не настроен: не задан TELEGRAM_BOT_TOKEN');
  }

  const verified = await verifyOrExplain(initData, botToken);
  const profile = {
    displayName: displayNameOf(verified.user),
    photoURL: verified.user.photoUrl ?? null,
    locale: verified.user.languageCode ?? 'ru',
    /** Ник берётся из Telegram: без него человека не найдут друзья. */
    username: usernameFromTelegram(verified.user.username),
  };

  logMetric(METRIC.SIGN_IN, { context: { provider: 'telegram', telegramId: verified.telegramId } });

  const common = {
    telegram: verified.user,
    /** Комната из deep-link — клиент откроет её сразу после входа. */
    startRoom: normalizeRoomCode(verified.startParam),
  };

  if (!hasServiceKey()) {
    return {
      ...common,
      mode: 'password',
      created: null,
      linked: false,
      email: telegramEmail(verified.telegramId),
      password: derivePassword(verified.telegramId, botToken),
      /** Уезжает в user_metadata: профиль заполнит триггер в базе. */
      metadata: {
        display_name: profile.displayName,
        photo_url: profile.photoURL,
        provider: 'telegram',
        external_key: verified.telegramId,
        locale: profile.locale,
      },
    };
  }

  const fallbackEmail = telegramEmail(verified.telegramId);
  const { userId, created } = await resolveUser(PROVIDER.TELEGRAM, verified.telegramId, {
    email: fallbackEmail,
    profile,
  });

  /*
   * Адрес берём у самого аккаунта, а не у Telegram: если идентичность
   * привязана к email-аккаунту, ссылка на вход должна выписываться на
   * его настоящую почту, иначе войдём не туда.
   */
  const account = await authAdmin.getUser(userId);
  const email = account?.email ?? fallbackEmail;
  const tokenHash = await authAdmin.generateSessionToken(email);

  return {
    ...common,
    mode: 'otp',
    tokenHash,
    created,
    /** Аккаунт заведён не Telegram-ом, значит вход пришёл по привязке. */
    linked: !email.endsWith('.invalid'),
  };
});

/**
 * Несошедшаяся подпись означает ровно одно: initData подписан не тем
 * токеном, что лежит на сервере. Но причин у этого две, и лечатся они
 * по-разному — Mini App открыт в другом боте либо на сервере чужой токен.
 * Отличить их по коду ошибки нельзя, поэтому ответ называет бота, от
 * имени которого сервер считает подпись. Юзернейм публичен.
 */
async function verifyOrExplain(initData, botToken) {
  try {
    return validateInitData(initData, { botToken });
  } catch (error) {
    if (error?.code !== 'initdata_invalid') throw error;
    const bot = await describeBot();
    const named = bot.username ? `@${bot.username}` : `бот ${bot.botId ?? 'неизвестен'}`;
    throw new ApiError(401, 'initdata_invalid',
      `Подпись Telegram не сошлась. Сервер проверяет её токеном ${named} — `
      + 'Mini App должен открываться в этом же боте. Если бот тот самый, '
      + 'токен на сервере обновился только что: закройте приложение полностью '
      + 'и откройте заново.',
      { context: { serverBot: bot.username ?? null, serverBotId: bot.botId ?? null } });
  }
}

/** Как записан юзернеймом бот в настройках: «@bot» и «bot» — одно и то же. */
const normalizeUsername = (value) =>
  String(value ?? '').trim().replace(/^@+/, '').toLowerCase() || null;

async function diagnostics() {
  const bot = hasBotToken() ? await describeBot() : { configured: false };

  /*
   * Ключевая проверка. VITE_TELEGRAM_BOT_USERNAME виден и серверу, так что
   * рассогласование «Mini App в одном боте, токен от другого» ловится здесь,
   * а не по жалобам пользователей на «Telegram не подтвердил личность».
   */
  const expected = normalizeUsername(process.env.VITE_TELEGRAM_BOT_USERNAME);
  const actual = normalizeUsername(bot.username);
  const mismatch = Boolean(expected && actual && expected !== actual);

  return {
    telegram: {
      configured: Boolean(bot.configured),
      tokenValid: Boolean(bot.tokenValid),
      botId: bot.botId ?? null,
      /** С этим юзернеймом должен совпадать бот, в котором открыт Mini App. */
      botUsername: bot.username ?? null,
      expectedBotUsername: expected,
      botMismatch: mismatch,
      /*
       * Инлайн-режим. От него зависит, откроется ли родной выбор чата
       * ПОВЕРХ Mini App или приглашение уйдёт ссылкой, закрыв приложение.
       */
      supportsInline: Boolean(bot.supportsInline),
      ...(bot.tokenValid && !bot.supportsInline ? {
        inlineHint: 'Инлайн-режим у бота выключен: @BotFather → /setinline → '
          + `@${actual ?? 'бот'} → любая подсказка. Без него приглашения `
          + 'и «поделиться» закрывают Mini App вместо родного выбора чата.',
      } : {}),
      ...(mismatch ? {
        hint: `TELEGRAM_BOT_TOKEN принадлежит @${actual}, а Mini App настроен на @${expected}. `
          + 'Подпись initData с таким сочетанием не сойдётся никогда — '
          + `возьмите у @BotFather токен бота @${expected}.`,
      } : {}),
      ...(bot.error ? { error: bot.error } : {}),
    },
    supabase: {
      serviceKey: hasServiceKey(),
      /** Без service_role привязка Telegram к существующему аккаунту выключена. */
      linkingAvailable: hasServiceKey(),
    },
    mode: hasServiceKey() ? 'otp' : 'password',
  };
}
