/**
 * Единая точка входа всех телеграмных эндпоинтов.
 *
 * На тарифе Hobby у Vercel потолок — двенадцать серверлес-функций
 * на выкладку, и три отдельных файла его пробили: сборка проходила,
 * а выкладка падала на `exceeded_serverless_functions_per_deployment`.
 *
 * Публичные адреса при этом не изменились: `/api/telegram/webhook`,
 * `/api/telegram/dispatch` и `/api/telegram/setup` доезжают сюда
 * переписыванием из vercel.json. Менять их было нельзя — первый
 * зарегистрирован у Telegram, второй записан в настройках базы.
 *
 * Сами обработчики живут в `_lib`: файлы оттуда Vercel функциями
 * не считает, поэтому логику можно держать раздельно, не платя
 * за это местом в лимите.
 */

import { webhookHandler } from '../_lib/botWebhook.js';
import { dispatchHandler } from '../_lib/botDispatch.js';
import { setupHandler } from '../_lib/botSetup.js';
import { notifyAllowHandler } from '../_lib/botNotifyAllow.js';
import { sendJson } from '../_lib/http.js';

const ROUTES = {
  webhook: webhookHandler,
  dispatch: dispatchHandler,
  setup: setupHandler,
  /* Разрешение писать, выданное родным окном Telegram в Mini App. */
  'notify-allow': notifyAllowHandler,
};

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host ?? 'localhost'}`);

  /*
   * Действие приходит из переписывания. Последний сегмент пути —
   * запасной вариант: он позволяет позвать обработчик напрямую,
   * когда переписывания нет (локальный запуск, отладка).
   */
  const action = url.searchParams.get('action')
    ?? url.pathname.replace(/\/$/, '').split('/').pop();

  const route = ROUTES[action];

  if (!route) {
    sendJson(res, 404, {
      ok: false,
      error: { code: 'not_found', message: `Неизвестное действие: ${action}` },
    });
    return;
  }

  await route(req, res);
}
