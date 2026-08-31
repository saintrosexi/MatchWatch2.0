-- MatchWatch: друзья по вкусу и живые уведомления о дружбе.
--
-- Три вещи одной миграцией, потому что по отдельности они не работают:
-- рекомендация без уведомления оставляет человека наедине с незнакомцем,
-- а уведомление без следующего шага не меняет ничего.
--
--   1. `suggested_friends` — кого посоветовать. По пересечению любимого,
--      а не по популярности: телефонная книжка (которой у нас и нет —
--      Telegram контакты не отдаёт) не говорит, с кем интересно смотреть
--      кино, а общие любимые говорят прямо. Порог в два фильма намеренный:
--      один общий любимый есть у всех, и рекомендация по нему — шум.
--
--   2. Постановка уведомлений в очередь. Очередь, обработчик и тексты
--      существовали и раньше, но класть в неё было некому: обе функции
--      молча писали в таблицу дружб. Человек узнавал о заявке, только
--      если сам заходил в приложение, — то есть когда напоминание
--      уже не нужно.
--
--   3. Защита от дубля. Нажать «добавить» дважды — обычное дело,
--      а два одинаковых сообщения подряд читаются как поломка.

create or replace function public.suggested_friends(p_limit integer default 12)
returns table (
  id uuid,
  username text,
  display_name text,
  photo_url text,
  bio text,
  shared_count integer
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with me as (select auth.uid() as uid),
  mine as (
    select f.title_id from public.favorites f, me where f.user_id = me.uid
  ),
  overlap as (
    select f.user_id, count(*)::int as shared
      from public.favorites f
      join mine on mine.title_id = f.title_id
      cross join me
     where f.user_id <> me.uid
     group by f.user_id
    having count(*) >= 2
  )
  select p.id, p.username, p.display_name, p.photo_url, p.bio, o.shared
    from overlap o
    join public.profiles p on p.id = o.user_id
    cross join me
   where p.username is not null
     and not exists (
       select 1 from public.friendships fr
        where fr.user_id = me.uid and fr.friend_id = p.id
     )
   order by o.shared desc, p.username
   limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

revoke all on function public.suggested_friends(integer) from public, anon;
grant execute on function public.suggested_friends(integer) to authenticated;

create unique index if not exists notifications_outbox_dedupe_key
  on public.notifications_outbox (dedupe_key) where dedupe_key is not null;

-- Тела `request_friend` и `accept_friend` повторяются целиком: дописать
-- строку в существующую функцию plpgsql иначе нельзя. Всё, кроме
-- постановки в очередь, оставлено дословно.
create or replace function public.request_friend(p_friend uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not_authenticated' using errcode = 'MW403'; end if;
  if v_me = p_friend then raise exception 'self_friend' using errcode = 'MW400'; end if;

  if exists (select 1 from public.friendships
             where user_id = p_friend and friend_id = v_me and requested_by = p_friend) then
    update public.friendships set status = 'accepted'
     where (user_id = p_friend and friend_id = v_me) or (user_id = v_me and friend_id = p_friend);

    insert into public.friendships (user_id, friend_id, status, requested_by)
    values (v_me, p_friend, 'accepted', p_friend)
    on conflict (user_id, friend_id) do update set status = 'accepted';

    insert into public.notifications_outbox (user_id, kind, payload, dedupe_key)
    values (p_friend, 'friend_accepted', jsonb_build_object('friend', v_me),
            'friend_accepted:' || p_friend::text || ':' || v_me::text)
    on conflict do nothing;

    return 'accepted';
  end if;

  insert into public.friendships (user_id, friend_id, status, requested_by)
  values (v_me, p_friend, 'pending', v_me)
  on conflict (user_id, friend_id) do nothing;

  insert into public.friendships (user_id, friend_id, status, requested_by)
  values (p_friend, v_me, 'pending', v_me)
  on conflict (user_id, friend_id) do nothing;

  insert into public.notifications_outbox (user_id, kind, payload, dedupe_key)
  values (p_friend, 'friend_request', jsonb_build_object('from', v_me),
          'friend_request:' || p_friend::text || ':' || v_me::text)
  on conflict do nothing;

  return 'pending';
end;
$function$;

create or replace function public.accept_friend(p_friend uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not_authenticated' using errcode = 'MW403'; end if;

  update public.friendships set status = 'accepted'
   where (user_id = v_me and friend_id = p_friend)
      or (user_id = p_friend and friend_id = v_me);

  insert into public.notifications_outbox (user_id, kind, payload, dedupe_key)
  values (p_friend, 'friend_accepted', jsonb_build_object('friend', v_me),
          'friend_accepted:' || p_friend::text || ':' || v_me::text)
  on conflict do nothing;
end;
$function$;
