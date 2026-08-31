-- MatchWatch: воронка первой волны, обратная связь и признак «бот запущен».
--
-- Три вещи, которые нужны ровно перед тем, как звать людей.
--
-- 1. ВОРОНКА. Считаем УНИКАЛЬНЫХ людей, дошедших до шага, а не события:
--    человек, свайпнувший триста раз, — по-прежнему один человек, и
--    складывать его свайпы значит смотреть на активность, а не
--    на прохождение. Шаги не вложены строго (до мэтча можно дойти,
--    не создавая комнату, — позвали тебя), поэтому проценты считаются
--    от ПЕРВОГО шага, а не от предыдущего: иначе выходит больше ста
--    и читается как ошибка. Калибровка — пятнадцать свайпов, ровно
--    столько карточек в стартовом наборе; отдельного события для неё
--    не заводим, оно было бы четвёртым источником правды о том же числе.
--
-- 2. ОБРАТНАЯ СВЯЗЬ. Цифры показывают, ЧТО отваливается, и никогда
--    не скажут, ПОЧЕМУ. Читать отзывы клиентским запросом нельзя вовсе:
--    политики на select нет, дашборд ходит сервисным ключом.
--
-- 3. ПРИЗНАК «БОТ ЗАПУЩЕН». Telegram не даёт боту написать первым,
--    а Mini App открывается ссылкой мимо чата с ботом — большинство
--    пришедших Start не нажимают, и вся очередь уведомлений копится
--    впустую. Приложение обязано знать об этом и позвать в чат само.

create or replace function public.ops_funnel(
  p_environment text default 'prod',
  p_days integer default 14
)
returns table (step text, label text, people integer, ordinal integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  with events as (
    select user_id, name
      from public.ops_metrics
     where environment = p_environment
       and created_at > now() - make_interval(days => greatest(1, p_days))
       and user_id is not null
  ),
  swipers as (
    select user_id from events where name = 'swipe'
     group by user_id having count(*) >= 15
  ),
  steps(step, label, ordinal) as (
    values
      ('app_open',        'Открыл приложение', 1),
      ('sign_in',         'Завёл аккаунт',     2),
      ('onboarding_done', 'Прошёл подсказки',  3),
      ('calibrated',      'Прошёл калибровку', 4),
      ('room_created',    'Создал комнату',    5),
      ('room_joined',     'Кто-то зашёл',      6),
      ('match',           'Дошёл до мэтча',    7)
  )
  select s.step, s.label,
         coalesce((
           case when s.step = 'calibrated'
             then (select count(*) from swipers)
             else (select count(distinct e.user_id) from events e where e.name = s.step)
           end
         ), 0)::int,
         s.ordinal
    from steps s
   order by s.ordinal;
$$;

revoke all on function public.ops_funnel(text, integer) from public, anon, authenticated;

create table if not exists public.feedback (
  id         bigserial primary key,
  user_id    uuid references auth.users on delete set null,
  body       text not null check (char_length(body) between 2 and 2000),
  context    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists feedback_created_idx on public.feedback (created_at desc);
alter table public.feedback enable row level security;

drop policy if exists feedback_write_own on public.feedback;
create policy feedback_write_own on public.feedback
  for insert with check (auth.uid() = user_id);

grant insert on public.feedback to authenticated;
grant usage, select on sequence public.feedback_id_seq to authenticated;

create or replace function public.bot_started()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.telegram_chats c
     where c.user_id = auth.uid() and c.notify and c.blocked_at is null
  );
$$;

revoke all on function public.bot_started() from public, anon;
grant execute on function public.bot_started() to authenticated;
