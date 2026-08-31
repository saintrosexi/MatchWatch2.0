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
import { sendMessage } from './botApi.js';
import { sbSelect } from './supabaseAdmin.js';
import { PREMIUM_CONFIG } from '../../shared/config/premium.js';
import { MODULE } from '../../shared/telemetry/events.js';

/** Что боту разрешено присылать. Адреса — только отсюда. */
const LINKS = {
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

  const { text, preview } = build();
  const result = await sendMessage(chatId, text, { preview });

  if (!result?.ok) {
    return { sent: false, reason: 'send_failed', description: result?.description ?? null };
  }

  return { sent: true };
});
