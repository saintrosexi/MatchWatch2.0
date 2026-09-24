/**
 * GET /api/ops/digest  (Vercel Cron, еженедельно)
 *
 * Сводка «топ-5 самых частых ошибок за период» — чтобы чинить по реальной
 * частоте, а не по ощущениям. Уходит тем же каналом, что и алерты.
 */

import { withHandler, ApiError } from './http.js';
import { sbRpc, sbSelect, hasServiceKey } from './supabaseAdmin.js';
import { sendAlert, telemetryEnv } from './telemetry.js';
import { MODULE } from '../../shared/telemetry/events.js';
import { clampInt } from './util.js';
import { assertCronAuthorized } from './opsRoomsGc.js';

export const digestHandler = withHandler({ methods: ['GET', 'POST'], module: MODULE.OPS }, async ({ req, query }) => {
  assertCronAuthorized(req, query);

  if (!hasServiceKey()) {
    throw new ApiError(503, 'ops_not_configured', 'Сводка недоступна: не задан SUPABASE_SERVICE_ROLE_KEY');
  }

  const days = clampInt(query.get('days'), 1, 30, 7);
  const env = query.get('env') ?? telemetryEnv;
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const [errors, business, daily] = await Promise.all([
    sbRpc('ops_top_failures', { p_environment: env, p_kind: 'error', p_days: days, p_limit: 5 }),
    sbRpc('ops_top_failures', { p_environment: env, p_kind: 'business', p_days: days, p_limit: 5 }),
    sbSelect('ops_daily', { select: '*', environment: `eq.${env}`, day: `gte.${since}` }),
  ]);

  const sum = (key) => (daily ?? []).reduce((a, row) => a + Number(row[key] ?? 0), 0);
  const swipes = sum('swipes');
  const matches = sum('matches');

  const lines = [
    `MatchWatch — сводка за ${days} дн. [${env}]`,
    '',
    `Свайпов: ${swipes} · мэтчей: ${matches} · доля: ${swipes ? ((matches / swipes) * 100).toFixed(1) : 0}%`,
    `Комнат создано: ${sum('rooms_created')} · приглашений: ${sum('invites_sent')}`,
    '',
    'Топ-5 ошибок:',
    ...((errors ?? []).length
      ? errors.map((e, i) => `${i + 1}. ${e.module} · ${e.name} — ${e.total}`)
      : ['  (ошибок нет)']),
    '',
    'Топ-5 сбоев логики:',
    ...((business ?? []).length
      ? business.map((e, i) => `${i + 1}. ${e.name} — ${e.total}`)
      : ['  (сбоев нет)']),
  ];

  const text = lines.join('\n');
  const delivered = await sendAlert(text);

  return {
    env, days, delivered, text,
    topErrors: errors ?? [],
    topBusinessFailures: business ?? [],
  };
});
