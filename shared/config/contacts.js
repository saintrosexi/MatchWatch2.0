/**
 * MatchWatch — официальные аккаунты в Telegram.
 *
 * Один список на всё приложение: канал, чат, поддержка, бот. Раньше
 * такого списка не было вовсе — до бота человек добирался только через
 * сообщение «мы прислали вам ссылку», а канала не существовало как
 * места, куда можно нажать.
 *
 * ────────────────────────────────────────────────────────────────
 * КАК ДОБАВИТЬ КАНАЛ
 *
 * Поставить юзернейм в `channel` — и всё. Раздел «Наши в Telegram»
 * подхватит его сам, кнопка появится, ссылка откроется поверх
 * приложения. Ничего больше править не нужно.
 *
 *     channel: { username: 'matchwatch', title: 'Канал MatchWatch',
 *                note: 'Что нового и что дальше' },
 * ────────────────────────────────────────────────────────────────
 *
 * `null` означает «такого аккаунта пока нет», и пункт просто
 * не показывается. Это намеренно: пустая строка в списке официальных
 * аккаунтов хуже, чем её отсутствие, — по ней нажмут.
 */

/** Юзернейм без «собачки»: в настройках его пишут и так, и так. */
const handle = (raw) => {
  const value = String(raw ?? '').trim().replace(/^@+/, '').replace(/^https?:\/\/t\.me\//i, '');
  return value || null;
};

/** Адрес чата, канала или бота в Telegram. */
export const telegramUrl = (username, startParam = null) => {
  const clean = handle(username);
  if (!clean) return null;
  return startParam ? `https://t.me/${clean}?start=${startParam}` : `https://t.me/${clean}`;
};

export const CONTACTS = {
  /** Канал с новостями. Появится — впишите юзернейм сюда. */
  channel: null,

  /** Чат сообщества. Тоже пока нет. */
  chat: null,

  /**
   * Отдельный аккаунт поддержки.
   *
   * Пока его нет, и это не пробел: обратная связь уходит формой внутри
   * приложения — она не требует ни Start, ни выхода из приложения,
   * и мы видим, с какого экрана пришло сообщение. Живой человек
   * в поддержке появится позже, и тогда сюда впишется его юзернейм.
   */
  support: null,
};

/**
 * Список официальных аккаунтов — тем порядком, в котором их показывать.
 *
 * Порядок по частоте нужды, а не по важности: чат с ботом нужен всем
 * и сразу (без него не приходят уведомления), канал — тем, кому
 * интересно продолжение, обменник — тем, кто упёрся в оплату.
 *
 * @param {{bot?: string|null, starsShop?: {url: string, label: string, note: string}|null}} options
 * @returns {Array<{key: string, kind: string, title: string, note: string, url: string}>}
 */
export function officialAccounts({ bot = null, starsShop = null, config = CONTACTS } = {}) {
  const list = [];

  /*
   * `start=hub` — не украшение. Нажатый в чате Start даёт боту право
   * писать человеку, а без этого права молча не приходят ни заявки
   * в друзья, ни приглашения в комнату.
   */
  const botUrl = telegramUrl(bot, 'hub');
  if (botUrl) {
    list.push({
      key: 'bot',
      kind: 'bot',
      title: 'Чат с ботом',
      note: 'Уведомления, приглашения и ссылки приходят сюда',
      url: botUrl,
    });
  }

  const channelUrl = telegramUrl(config.channel?.username);
  if (channelUrl) {
    list.push({
      key: 'channel',
      kind: 'channel',
      title: config.channel.title ?? 'Наш канал',
      note: config.channel.note ?? 'Что нового и что дальше',
      url: channelUrl,
    });
  }

  const chatUrl = telegramUrl(config.chat?.username);
  if (chatUrl) {
    list.push({
      key: 'chat',
      kind: 'chat',
      title: config.chat.title ?? 'Чат сообщества',
      note: config.chat.note ?? 'Обсуждение и вопросы',
      url: chatUrl,
    });
  }

  const supportUrl = telegramUrl(config.support?.username);
  if (supportUrl) {
    list.push({
      key: 'support',
      kind: 'support',
      title: config.support.title ?? 'Поддержка',
      note: config.support.note ?? 'Ответим живым человеком',
      url: supportUrl,
    });
  }

  if (starsShop?.url) {
    list.push({
      key: 'stars_shop',
      kind: 'shop',
      title: 'Где купить Telegram Stars',
      note: starsShop.note ?? 'Обменник, которым пользуемся сами',
      url: starsShop.url,
    });
  }

  return list;
}
