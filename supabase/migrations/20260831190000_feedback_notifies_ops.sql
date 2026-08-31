-- Сообщение в поддержку доходит до владельца сразу, а не когда он вспомнит
-- заглянуть в дашборд.
--
-- Обратная связь ценна ровно первые часы: человек ещё за экраном, ещё
-- помнит, что делал, и на уточняющий вопрос ответит. Через сутки он уже
-- ушёл, и тот же отзыв стоит вдвое меньше.
--
-- Ставим в ту же очередь `notifications_outbox`, что и заявки в друзья:
-- у неё уже есть рассыльщик, повторные попытки и защита от дублей.
-- Отдельный канал доставки пришлось бы чинить отдельно.

-- Кому слать: всем, у кого поднят `is_ops`. Список читается в момент
-- события, а не хранится где-то ещё, — новый владелец начнёт получать
-- письма сам, без правки кода.
create or replace function public.notify_ops_on_feedback()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.notifications_outbox (user_id, kind, payload, dedupe_key)
  select
    p.id,
    'feedback',
    jsonb_build_object('feedback', new.id, 'from', new.user_id),
    -- По одному письму на владельца на сообщение: повтор вставки
    -- (ретрай, миграция) не разбудит его во второй раз.
    'feedback:' || new.id::text || ':' || p.id::text
  from public.profiles p
  where p.is_ops
    -- Себе не пишем: владелец, отправивший отзыв из приложения, и так
    -- знает, что он написал.
    and p.id is distinct from new.user_id
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists feedback_notifies_ops on public.feedback;

create trigger feedback_notifies_ops
  after insert on public.feedback
  for each row
  execute function public.notify_ops_on_feedback();

-- Рассыльщик читает текст отзыва сам, сервисным ключом: класть тело
-- сообщения в очередь значило бы держать его в двух местах и рисковать
-- тем, что письмо и дашборд покажут разное.
revoke all on function public.notify_ops_on_feedback() from public, anon, authenticated;
