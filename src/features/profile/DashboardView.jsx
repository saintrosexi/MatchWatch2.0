import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw } from '../../ui/icons.js';
import { api } from '../../lib/api.js';
import { ErrorState, LoadingState } from '../../ui/States.jsx';

/**
 * Минимальный дашборд продуктовых метрик.
 *
 * Смысл — иметь цифры с первого дня, а не только сырые логи: создание
 * комнат, доля свайпов с мэтчем, retention D1/D7, приглашения на
 * пользователя и топ ошибок, чтобы чинить по частоте, а не по ощущениям.
 */
export function DashboardView({ onBack }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      /*
       * Без токена: владелец открывает дашборд своей же учёткой,
       * по признаку `is_ops` в профиле. Поле для токена стояло здесь
       * с тех пор, когда другого способа не было, и приглашало ввести
       * то, чего у владельца никогда не было на руках, — из-за него
       * дашборд и выглядел неработающим.
       *
       * Сам токен как запасной путь для внешнего дашборда остался
       * на стороне API — просто в приложении он не нужен.
       */
      const payload = await api.metrics(days);
      setData(payload);
    } catch (e) {
      setError({ text: e?.message ?? 'Не удалось загрузить метрики', retryable: true });
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const peak = Math.max(1, ...(data?.timeline ?? []).map((d) => Math.max(d.swipes, d.dau)));

  return (
    <div className="view">
      <button type="button" className="btn btn--quiet btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <ArrowLeft size={16} /> Назад
      </button>

      <header className="view__head">
        <h1 className="view__title">Дашборд</h1>
        <p className="view__sub">Окружение: {data?.env ?? '—'} · период {days} дн.</p>
      </header>

      <div className="row gap-2">
        {[7, 14, 30].map((d) => (
          <button
            key={d}
            type="button"
            className={`chip chip--interactive ${days === d ? 'chip--on' : ''}`}
            onClick={() => setDays(d)}
          >
            {d} дн
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={load} aria-label="Обновить">
          <RefreshCw size={16} />
        </button>
      </div>

      {loading && !data && <LoadingState text="Считаем метрики…" />}
      {error && !data && <ErrorState error={error} onRetry={load} module="ops.metrics" />}

      {data && (
        <>
          <div className="dash-grid">
            <Metric label="Свайпов" value={data.totals.swipes} />
            <Metric label="Мэтчей" value={data.totals.matches} />
            <Metric label="Доля мэтчей" value={`${data.totals.matchRate}%`} tone="gold" />
            <Metric label="Комнат создано" value={data.totals.roomsCreated} />
            <Metric label="Приглашений / юзер" value={data.totals.invitesPerUser} />
            <Metric label="Retention D1" value={fmtPercent(data.retention.averageD1)} tone="gold" />
            <Metric label="Retention D7" value={fmtPercent(data.retention.averageD7)} tone="gold" />
            <Metric label="Ошибок" value={data.totals.errors} tone={data.totals.errors ? 'alarm' : undefined} />
          </div>

          {/*
            * Воронка стоит выше графиков намеренно: она отвечает
            * на вопрос «где рвётся путь», а активность по дням — только
            * на «сколько». Первое важнее, пока продукт никому не показан.
            */}
          <section className="section">
            <h2 className="section__title">Воронка первой волны</h2>
            <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
              Уникальные люди, дошедшие до шага. Проценты — от первого шага,
              а не от предыдущего: шаги не вложены строго, до мэтча можно
              дойти, не создавая комнату.
            </p>
            <div className="funnel-steps">
              {(data.funnel ?? []).map((step, i) => {
                const prev = data.funnel[i - 1];
                /* Падение считаем от предыдущего — именно оно и есть отвал. */
                const drop = prev && prev.people > step.people
                  ? prev.people - step.people
                  : 0;
                return (
                  <div className="funnel-step" key={step.step}>
                    <div className="funnel-step__head">
                      <span className="funnel-step__label">{step.label}</span>
                      <span className="funnel-step__value">
                        {step.people}
                        <span className="faint"> · {step.share}%</span>
                      </span>
                    </div>
                    <div className="funnel-step__track">
                      <div className="funnel-step__fill" style={{ width: `${step.share}%` }} />
                    </div>
                    {drop > 0 && (
                      <span className="funnel-step__drop">−{drop} на этом шаге</span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="section">
            <h2 className="section__title">Что пишут</h2>
            <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
              Цифры показывают, что отваливается. Это — почему.
            </p>
            {(data.feedback ?? []).length === 0 ? (
              <p className="faint" style={{ fontSize: 'var(--t-small)' }}>
                Сообщений пока нет.
              </p>
            ) : (
              <div className="stack gap-2">
                {data.feedback.map((item) => (
                  <div className="feedback-item" key={item.id}>
                    <p className="feedback-item__body">{item.body}</p>
                    <span className="feedback-item__meta">
                      {new Date(item.at).toLocaleString('ru-RU', {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                      {item.screen ? ` · ${item.screen}` : ''}
                      {item.release ? ` · ${item.release}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="section">
            <h2 className="section__title">Активность по дням</h2>
            <div className="surface dash-chart">
              {data.timeline.map((day) => (
                <div
                  key={day.day}
                  className="dash-chart__bar"
                  style={{ height: `${Math.max(2, (day.swipes / peak) * 100)}%` }}
                  title={`${day.day}: ${day.swipes} свайпов, ${day.matches} мэтчей, DAU ${day.dau}`}
                />
              ))}
            </div>
          </section>

          <section className="section">
            <h2 className="section__title">Топ-5 ошибок</h2>
            <table className="dash-table">
              <thead><tr><th>Модуль</th><th>Событий</th></tr></thead>
              <tbody>
                {data.topErrors.length === 0
                  ? <tr><td colSpan={2} className="faint">Ошибок за период нет</td></tr>
                  : data.topErrors.map((row) => (
                    <tr key={row.name}><td>{row.name}</td><td>{row.count}</td></tr>
                  ))}
              </tbody>
            </table>
          </section>

          <section className="section">
            <h2 className="section__title">Топ-5 сбоев логики</h2>
            <p className="faint" style={{ fontSize: 'var(--t-micro)' }}>
              Не исключения кода: «комната не найдена», «TMDB пустой ответ», «rules отклонили запись».
            </p>
            <table className="dash-table">
              <thead><tr><th>Событие</th><th>Раз</th></tr></thead>
              <tbody>
                {data.topBusinessFailures.length === 0
                  ? <tr><td colSpan={2} className="faint">Сбоев за период нет</td></tr>
                  : data.topBusinessFailures.map((row) => (
                    <tr key={row.name}><td>{row.name}</td><td>{row.count}</td></tr>
                  ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, tone }) {
  const color = tone === 'gold' ? 'var(--gold)' : tone === 'alarm' ? 'var(--coral)' : 'var(--text-hi)';
  return (
    <div className="stat">
      <span className="stat__value" style={{ color }}>{value ?? '—'}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

const fmtPercent = (value) => (value === null || value === undefined ? '—' : `${value}%`);
