/**
 * POST /api/telegram/notify-allow
 *
 * Человек разрешил боту писать ему прямо в Mini App, родным окном
 * `requestWriteAccess`. Разрешение живёт у Telegram, но рассыльщик
 * о нём не знает: он ищет строку в `telegram_chats` и без неё молча
 * складывает уведомления в очередь.
 *
 * Здесь эта строка и появляется. Нажатие Start больше не обязательно:
 * до сих пор оно было единственным способом получить право писать,
 * и именно поэтому таблица оставалась пустой — Mini App открывается
 * ссылкой мимо чата с ботом, и Start не нажимает почти никто.
 *
 * Кому писать, мы берём ИЗ ПОДПИСАННОГО initData, а не из тела запроса.
 * Иначе любой смог бы подписать чужой идентификатор на уведомления.
 * В личном чате `chat_id` совпадает с идентификатором пользователя —
 * отдельно его взять неоткуда и не нужно.
 */

import { withHandler, badRequest } from './http.js';
import { validateInitData } from './telegram.js';
import { sbInsert, sbSelect } from './supabaseAdmin.js';
import { logMetric } from './telemetry.js';
import { METRIC, MODULE } from '../../shared/telemetry/events.js';

export const notifyAllowHandler = withHandler({
  methods: ['POST'],
  module: MODULE.AUTH_TELEGRAM,
  /* Ответ «разрешили» без записи — та же ложь, что и потерянный журнал. */
  awaitTelemetry: true,
}, async ({ body }) => {
  const { telegramId, user } = validateInitData(body?.initData);
  if (!telegramId) throw badRequest('telegram_user_missing', 'Telegram не передал пользователя');

  /*
   * Без привязки к профилю разрешение бесполезно: и проверка «бот
   * запущен», и рассыльщик ищут строку ПО ПРОФИЛЮ. Такое бывает
   * у того, кто завёл аккаунт по почте, а Mini App открыл в Telegram
   * под другим человеком. Врать ему «готово» нельзя.
   */
  const userId = await linkedUserId(telegramId);

  await sbInsert('telegram_chats', [{
    telegram_id: telegramId,
    /* Личный чат с ботом: идентификатор чата равен идентификатору человека. */
    chat_id: telegramId,
    user_id: userId,
    username: user.username ?? null,
    /*
     * Разрешение снимает и прежний отказ, и отметку о блокировке:
     * человек только что согласился сам, и старое «нет» перестало
     * быть его мнением.
     */
    blocked_at: null,
    notify: true,
  }], { upsert: true, onConflict: 'telegram_id' });

  logMetric(METRIC.BOT_STARTED, { context: { via: 'write_access' } });

  return { allowed: true, linked: Boolean(userId) };
});

/** Профиль, к которому привязан этот Telegram, — если привязка уже есть. */
async function linkedUserId(telegramId) {
  const rows = await sbSelect('identities', {
    select: 'user_id',
    provider: 'eq.telegram',
    external_key: `eq.${telegramId}`,
    limit: 1,
  });
  return rows?.[0]?.user_id ?? null;
}
