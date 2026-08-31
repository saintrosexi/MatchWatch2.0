/**
 * POST /api/telegram/prepare-share
 *
 * Готовит сообщение, которое человек отправит из НАТИВНОГО окна выбора
 * чата, не выходя из Mini App.
 *
 * ────────────────────────────────────────────────────────────────
 * ЗАЧЕМ, ЕСЛИ ЕСТЬ switchInlineQuery
 *
 * `switchInlineQuery` открывает выбор чата, но по устройству УХОДИТ
 * в выбранный чат: он вставляет запрос в поле ввода, а значит обязан
 * этот чат открыть. Mini App при этом закрывается — это не сбой
 * и не наша ошибка, это его работа.
 *
 * `shareMessage` (Bot API 8.0) сделан ровно для нашего случая: родное
 * окно выбора рисуется ПОВЕРХ приложения, сообщение уходит выбранному
 * человеку, а Mini App остаётся открытым. Но отправить он может только
 * заранее подготовленное сообщение — его и готовит этот эндпоинт.
 *
 * Заодно решается вторая жалоба: «мало чатов». `switchInlineQuery`
 * показывает лишь те чаты, где инлайн-режим разрешён, а подготовленное
 * сообщение уходит и в личные, и в группы, и в каналы — что разрешать,
 * сказано ниже явно.
 * ────────────────────────────────────────────────────────────────
 *
 * Содержимое собирается ЗДЕСЬ, а не приходит от клиента: иначе эндпоинт
 * стал бы способом разослать что угодно от имени нашего бота.
 */

import { withHandler, badRequest } from './http.js';
import { validateInitData } from './telegram.js';
import { appLink, callBot, esc, linkButton } from './botApi.js';
import { normalizeRoomCode } from '../../shared/model/roomCode.js';
import { sbSelect } from './supabaseAdmin.js';
import { MODULE } from '../../shared/telemetry/events.js';

const KINDS = {
  room_invite: ({ code }) => ({
    id: `room-${code}`,
    title: `Комната ${code}`,
    description: 'Позвать выбрать кино вместе',
    text: `🍿 <b>Выберем кино вместе?</b>\n\nКомната <b>${esc(code)}</b>. `
      + 'Свайпаете каждый со своего телефона, а приложение покажет, '
      + 'на чём вы сошлись.',
    button: [`Войти в комнату ${code}`, appLink(code)],
  }),

  profile: ({ username }) => ({
    id: `profile-${username}`,
    title: 'Мой профиль в MatchWatch',
    description: 'Вкус, любимые фильмы и совпадения',
    text: `🎬 <b>Мой профиль в MatchWatch</b>\n\n`
      + 'Любимые фильмы, темы вкуса и то, на сколько мы с вами совпадаем.',
    button: ['Посмотреть профиль', appLink(`u_${username}`)],
  }),
};

export const prepareShareHandler = withHandler({
  methods: ['POST'],
  module: MODULE.BOT,
}, async ({ body }) => {
  const build = KINDS[body?.kind];
  if (!build) throw badRequest('unknown_kind', 'Неизвестный вид сообщения');

  const { telegramId } = validateInitData(body?.initData);

  const params = await resolveParams(body);
  const card = build(params);

  /*
   * `allow_*` перечислены явно и щедро: узкий набор — ровно та причина,
   * по которой в прежнем окне было «мало чатов». Приглашение уместно
   * и в личку, и в общий чат, где сидят оба.
   */
  const result = await callBot('savePreparedInlineMessage', {
    user_id: Number(telegramId),
    allow_user_chats: true,
    allow_group_chats: true,
    allow_channel_chats: true,
    result: {
      type: 'article',
      id: card.id.slice(0, 64),
      title: card.title,
      description: card.description,
      input_message_content: {
        message_text: card.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      },
      ...(card.button?.[1] ? { reply_markup: linkButton(card.button[0], card.button[1]) } : {}),
    },
  });

  if (!result?.ok) {
    /*
     * Метод появился в Bot API 8.0. Если Telegram его не знает, клиенту
     * нужен не общий сбой, а причина: у него есть запасные пути, и он
     * должен понимать, что подготовленное сообщение здесь недоступно
     * в принципе, а не «не получилось в этот раз».
     */
    return { prepared: false, reason: 'unavailable', description: result?.description ?? null };
  }

  return { prepared: true, id: result.result?.id ?? null };
});

/** Разбор и проверка того, что пришло от клиента. */
async function resolveParams(body) {
  if (body.kind === 'room_invite') {
    const code = normalizeRoomCode(body?.code);
    if (!code) throw badRequest('room_code_required', 'Нужен код комнаты');

    /* Зовём только в живую комнату: иначе бот рассылает мёртвые коды. */
    const rooms = await sbSelect('rooms', {
      select: 'code', code: `eq.${code}`, status: 'eq.open', limit: 1,
    });
    if (!rooms?.length) throw badRequest('room_not_found', 'Комната не найдена или закрыта');

    return { code };
  }

  const username = String(body?.username ?? '').trim().replace(/^@/, '').slice(0, 32);
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    throw badRequest('username_required', 'Нужен ник профиля');
  }
  return { username };
}
