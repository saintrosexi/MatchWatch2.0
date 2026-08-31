/**
 * POST /api/telegram/send-link
 *
 * Бот присылает человеку ссылку сообщением, вместо того чтобы приложение
 * закрывалось у него на глазах.
 *
 * `openTelegramLink` штатно закрывает Mini App, и если клиент почему-то
 * не откроет чат — а на Telegram Desktop это случается, — человек
 * остаётся с закрывшимся приложением и без всякого объяснения. Хуже
 * того, вернуться ему некуда: ссылки он больше не видит.
 *
 * Сообщение решает это целиком. Приложение не закрывается, ссылка лежит
 * в чате, по ней можно нажать когда угодно и вернуться к ней позже.
 *
 * ────────────────────────────────────────────────────────────────
 * ПОЧЕМУ НЕ ПРИНИМАЕМ ССЫЛКУ ОТ КЛИЕНТА
 *
 * Эндпоинт, отправляющий произвольный адрес в Telegram от имени нашего
 * бота, — это открытый ретранслятор для чужих ссылок. Поэтому клиент
 * передаёт ВИД ссылки, а сам адрес берётся из конфига на сервере.
 * ────────────────────────────────────────────────────────────────
 */

import { withHandler, badRequest } from './http.js';
import { validateInitData } from './telegram.js';
import { esc, openAppButton, sendMessage } from './botApi.js';
import { normalizeRoomCode } from '../../shared/model/roomCode.js';
import { sbSelect } from './supabaseAdmin.js';
import { PREMIUM_CONFIG } from '../../shared/config/premium.js';
import { MODULE } from '../../shared/telemetry/events.js';

/** Что боту разрешено присылать. Адреса — только отсюда. */
const LINKS = {
  /**
   * Приглашение в комнату — пересылаемой карточкой.
   *
   * Родной выбор чата (`switchInlineQuery`) доступен не всегда: Telegram
   * отказывает, когда Mini App открыт не из чата, а по прямой ссылке.
   * Раньше в этом случае приглашение уходило ссылкой, закрывавшей
   * приложение, — человек нажимал «Пригласить» и терял и комнату,
   * и ссылку.
   *
   * Здесь бот присылает карточку самому приглашающему, и тот пересылает
   * её кому хочет обычным способом. На одно касание больше, зато
   * приложение не закрывается, а у получателя оказывается не голый
   * адрес, а сообщение с кодом и кнопкой входа.
   */
  room_invite: ({ code }) => ({
    text: `🍿 <b>Комната ${esc(code)}</b>\n\n`
      + 'Заходите — выберем кино вместе. Свайпаете каждый со своего '
      + 'телефона, а приложение покажет, на чём вы сошлись.\n\n'
      + '<i>Перешлите это сообщение тому, кого зовёте.</i>',
    keyboard: openAppButton(`Войти в комнату ${code}`, { startParam: code }),
    preview: false,
  }),

  stars_shop: () => ({
    text: `⭐ <b>Где купить Telegram Stars</b>\n\n${PREMIUM_CONFIG.starsShop.url}\n\n`
      + `<i>${PREMIUM_CONFIG.starsShop.note}</i>`,
    /*
     * Предпросмотр включён намеренно: карточка бота-обменника делает
     * ссылку узнаваемой и кликабельной крупным пятном, а не строчкой
     * мелкого синего текста.
     */
    preview: true,
  }),
};

export const sendLinkHandler = withHandler({
  methods: ['POST'],
  module: MODULE.BOT,
}, async ({ body }) => {
  const build = LINKS[body?.kind];
  if (!build) throw badRequest('unknown_link', 'Неизвестный вид ссылки');

  const { telegramId } = validateInitData(body?.initData);

  /*
   * Код комнаты приходит от клиента, поэтому проверяется дважды: формат
   * здесь, а принадлежность к живой комнате — ниже. Без второй проверки
   * эндпоинт рассылал бы приглашения в чужие и несуществующие комнаты
   * от имени нашего бота.
   */
  const code = body?.kind === 'room_invite' ? normalizeRoomCode(body?.code) : null;
  if (body?.kind === 'room_invite' && !code) {
    throw badRequest('room_code_required', 'Нужен код комнаты');
  }

  /*
   * Право писать проверяем ДО отправки и отвечаем причиной, а не общей
   * ошибкой: интерфейсу нужно различать «не разрешал» и «сломалось».
   * В первом случае человеку можно предложить разрешить прямо сейчас,
   * во втором предлагать нечего.
   */
  const rows = await sbSelect('telegram_chats', {
    select: 'chat_id',
    telegram_id: `eq.${telegramId}`,
    notify: 'is.true',
    blocked_at: 'is.null',
    limit: 1,
  });

  const chatId = rows?.[0]?.chat_id;
  if (!chatId) return { sent: false, reason: 'no_chat' };

  if (code) {
    const rooms = await sbSelect('rooms', {
      select: 'code', code: `eq.${code}`, status: 'eq.open', limit: 1,
    });
    if (!rooms?.length) return { sent: false, reason: 'room_not_found' };
  }

  const { text, keyboard, preview } = build({ code });
  const result = await sendMessage(chatId, text, { keyboard, preview });

  if (!result?.ok) {
    return { sent: false, reason: 'send_failed', description: result?.description ?? null };
  }

  return { sent: true };
});
