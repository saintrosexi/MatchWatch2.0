/**
 * GET /api/ops/metrics?days=14
 *
 * Данные для дашборда: создание комнат, доля свайпов с мэтчем,
 * retention D1/D7, приглашения на пользователя, топ-5 ошибок.
 *
 * Считает Postgres — представление ops_daily и функции ops_retention /
 * ops_top_failures. Ручных счётчиков больше нет: агрегаты выводятся из
 * сырых событий, поэтому их можно пересчитать задним числом.
 *
 * Доступ — по своей же учётной записи с признаком `is_ops` в профиле.
 * Отдельный секрет остаётся как запасной путь для внешних дашбордов,
 * но задавать его больше не обязательно: раньше без него метрики
 * не открывались вообще никому, включая владельца приложения.
 */

import { withHandler, ApiError, requireSecret } from './http.js';
import { requireUser } from './session.js';
import { sbSelect, sbRpc, hasServiceKey } from './supabaseAdmin.js';
import { telemetryEnv } from './telemetry.js';
import { MODULE } from '../../shared/telemetry/events.js';
import { clampInt } from './util.js';

const dayKeyOffset = (offset) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);

/**
 * Пускает либо по секрету, либо по своей учётке с признаком `is_ops`.
 *
 * Признак живёт в профиле и ставится только из базы: в поколоночный
 * grant для роли authenticated колонка не входит, так что выдать её
 * себе с клиента нельзя.
 */
async function requireOpsAccess(req, query) {
  const secret = process.env.OPS_DASHBOARD_TOKEN;
  const provided = req.headers?.authorization?.replace(/^Bearer\s+/i, '') ?? query?.get?.('token');

  // Секрет задан и передан именно он — это внешний дашборд.
  if (secret && provided && provided === secret) {
    requireSecret(req, query, 'OPS_DASHBOARD_TOKEN');
    return;
  }

  const user = await requireUser(req);
  const rows = await sbSelect('profiles', {
    select: 'is_ops', id: `eq.${user.id}`, limit: '1',
  });

  if (!rows?.[0]?.is_ops) {
    throw new ApiError(403, 'ops_forbidden', 'Метрики доступны только владельцам приложения');
  }
}

export const metricsHandler = withHandler({ methods: ['GET'], module: MODULE.OPS }, async ({ query, req }) => {
  await requireOpsAccess(req, query);
  if (!hasServiceKey()) {
    throw new ApiError(503, 'ops_not_configured',
      'Метрики недоступны: не задан SUPABASE_SERVICE_ROLE_KEY');
  }

  const days = clampInt(query.get('days'), 1, 60, 14);
  const env = query.get('env') ?? telemetryEnv;
  const since = dayKeyOffset(days - 1);

  const [daily, retention, topErrors, topBusiness, funnel, feedback] = await Promise.all([
    sbSelect('ops_daily', {
      select: '*', environment: `eq.${env}`, day: `gte.${since}`, order: 'day.asc',
    }),
    sbRpc('ops_retention', { p_environment: env, p_days: days }),
    sbRpc('ops_top_failures', { p_environment: env, p_kind: 'error', p_days: days, p_limit: 5 }),
    sbRpc('ops_top_failures', { p_environment: env, p_kind: 'business', p_days: days, p_limit: 5 }),
    sbRpc('ops_funnel', { p_environment: env, p_days: days }),
    /*
     * Отзывы читаются сервисным ключом: политика на чтение не заведена
     * намеренно, чтобы чужие отзывы нельзя было вытащить клиентским
     * запросом ни при каких обстоятельствах.
     */
    sbSelect('feedback', {
      select: 'id,body,context,created_at,user_id',
      order: 'created_at.desc',
      limit: '30',
    }),
  ]);

  const byDay = new Map((daily ?? []).map((row) => [row.day, row]));

  const timeline = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = dayKeyOffset(i);
    const row = byDay.get(day) ?? {};
    const swipes = Number(row.swipes ?? 0);
    const matches = Number(row.matches ?? 0);
    timeline.push({
      day,
      dau: Number(row.dau ?? 0),
      roomsCreated: Number(row.rooms_created ?? 0),
      roomsJoined: Number(row.rooms_joined ?? 0),
      invitesSent: Number(row.invites_sent ?? 0),
      swipes,
      matches,
      /** Доля свайпов, закончившихся мэтчем — ключевая метрика продукта. */
      matchRate: swipes ? Math.round((matches / swipes) * 10000) / 100 : 0,
      watchlistAdds: Number(row.watchlist_adds ?? 0),
      rouletteSpins: Number(row.roulette_spins ?? 0),
    });
  }

  const cohorts = (retention ?? []).map((row) => ({
    cohort: row.cohort_day,
    size: Number(row.cohort_size ?? 0),
    d1: row.d1 === null ? null : Number(row.d1),
    d7: row.d7 === null ? null : Number(row.d7),
  }));

  const totals = timeline.reduce((acc, row) => {
    for (const key of ['dau', 'roomsCreated', 'roomsJoined', 'invitesSent', 'swipes', 'matches']) {
      acc[key] = (acc[key] ?? 0) + row[key];
    }
    return acc;
  }, {});

  totals.signups = cohorts.reduce((a, c) => a + c.size, 0);
  totals.matchRate = totals.swipes ? Math.round((totals.matches / totals.swipes) * 10000) / 100 : 0;
  totals.invitesPerUser = totals.signups
    ? Math.round((totals.invitesSent / totals.signups) * 100) / 100 : 0;
  totals.errors = (topErrors ?? []).reduce((a, r) => a + Number(r.total ?? 0), 0);
  totals.businessFailures = (topBusiness ?? []).reduce((a, r) => a + Number(r.total ?? 0), 0);

  /*
   * Проценты воронки считаются от ПЕРВОГО шага, а не от предыдущего.
   *
   * Шаги не вложены строго: до мэтча можно дойти, не создавая комнату,
   * — позвали тебя. «Процент от предыдущего» в такой воронке даёт
   * значения больше ста и читается как ошибка.
   */
  const funnelTop = Number(funnel?.[0]?.people ?? 0);
  const funnelSteps = (funnel ?? []).map((row) => ({
    step: row.step,
    label: row.label,
    people: Number(row.people ?? 0),
    share: funnelTop ? Math.round((Number(row.people) / funnelTop) * 1000) / 10 : 0,
  }));

  return {
    env,
    days,
    timeline,
    totals,
    funnel: funnelSteps,
    feedback: (feedback ?? []).map((row) => ({
      id: row.id,
      body: row.body,
      at: row.created_at,
      screen: row.context?.screen ?? null,
      release: row.context?.release ?? null,
    })),
    retention: {
      cohorts,
      averageD1: average(cohorts.map((c) => c.d1).filter((v) => v !== null)),
      averageD7: average(cohorts.map((c) => c.d7).filter((v) => v !== null)),
    },
    topErrors: (topErrors ?? []).map((r) => ({ name: `${r.module} · ${r.name}`, count: Number(r.total) })),
    topBusinessFailures: (topBusiness ?? []).map((r) => ({ name: r.name, count: Number(r.total) })),
    generatedAt: Date.now(),
  };
});

const average = (values) =>
  (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null);
