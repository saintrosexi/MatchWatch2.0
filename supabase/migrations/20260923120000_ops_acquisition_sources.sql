-- MatchWatch: откуда приходят люди — отчёт по меткам кампаний.
--
-- Продвижение начинается с того, что каждая ссылка подписана:
-- `t.me/<bot>/<app>?startapp=src_habr`, `/welcome?utm_source=vk`.
-- Приложение пишет метку в контекст `app_open`, бот — в `bot_started`
-- (см. shared/model/startParam.js → acquisitionSource). Здесь метки
-- сводятся в таблицу «источник → сколько пришло → сколько дошло».
--
-- Считается ПЕРВОЕ касание в окне: человек, пришедший из поста на Хабре,
-- а через день открывший приглашение друга, — заслуга Хабра. Иначе
-- сарафан присваивал бы себе всех, кого привели посты.
--
-- «Дошёл» — две ступени, которые говорят о качестве трафика, а не
-- об объёме: калибровка (пятнадцать свайпов, как в воронке) и мэтч.
-- Сто человек, закрывших приложение на второй карточке, стоят меньше,
-- чем десять, дошедших до мэтча.
--
-- Строка `direct` — открывшие приложение без всякой метки. Она нужна,
-- чтобы видеть долю подписанного трафика: если почти всё — `direct`,
-- значит ссылки в постах уходят без меток и отчёт врёт.

create or replace function public.ops_acquisition(
  p_environment text default 'prod',
  p_days integer default 14
)
returns table (source text, people integer, calibrated integer, matched integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  with events as (
    select user_id, name, context, created_at
      from public.ops_metrics
     where environment = p_environment
       and created_at > now() - make_interval(days => greatest(1, p_days))
       and user_id is not null
  ),
  first_touch as (
    select distinct on (user_id) user_id, context->>'source' as source
      from events
     where name in ('app_open', 'bot_started')
       and coalesce(context->>'source', '') <> ''
     order by user_id, created_at asc
  ),
  touched as (
    select user_id, source from first_touch
    union all
    select user_id, 'direct' from (
      select distinct user_id from events where name = 'app_open'
      except
      select user_id from first_touch
    ) unlabeled
  ),
  swipers as (
    select user_id from events where name = 'swipe'
     group by user_id having count(*) >= 15
  ),
  matchers as (
    select distinct user_id from events where name = 'match'
  )
  select t.source,
         count(*)::int,
         count(s.user_id)::int,
         count(m.user_id)::int
    from touched t
    left join swipers s on s.user_id = t.user_id
    left join matchers m on m.user_id = t.user_id
   group by t.source
   order by count(*) desc, t.source
   limit 30;
$$;

revoke all on function public.ops_acquisition(text, integer) from public, anon, authenticated;
