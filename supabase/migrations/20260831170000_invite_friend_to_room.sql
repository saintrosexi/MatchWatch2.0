-- MatchWatch: позвать друга в комнату изнутри приложения.
--
-- Отдельно от ссылки-приглашения, и это разные задачи. Ссылку кидают
-- кому угодно, включая тех, у кого MatchWatch ещё нет. Здесь зовут
-- конкретного друга: ему приходит уведомление с кнопкой прямо в комнату,
-- и код вводить не нужно вовсе.
--
-- Два условия, и оба обязательны:
--   1. зовущий сам в комнате — иначе можно рассылать приглашения
--      в чужие комнаты, зная только код;
--   2. они друзья — иначе это готовый канал для спама любому,
--      чей идентификатор угадан.
--
-- Ключ защиты от дубля включает код комнаты: позвать человека в ДРУГУЮ
-- комнату тем же вечером законно, а дважды в одну и ту же — нет.

create or replace function public.invite_to_room(p_code text, p_friend uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not_authenticated' using errcode = 'MW403'; end if;
  if v_me = p_friend then raise exception 'self_invite' using errcode = 'MW400'; end if;

  if not exists (
    select 1 from public.room_members m
     where m.room_code = p_code and m.user_id = v_me
  ) then
    raise exception 'not_in_room' using errcode = 'MW403';
  end if;

  if not exists (
    select 1 from public.friendships f
     where f.user_id = v_me and f.friend_id = p_friend and f.status = 'accepted'
  ) then
    raise exception 'not_friends' using errcode = 'MW403';
  end if;

  -- Уже внутри — звать некого. Молча выходим, а не падаем: хост может
  -- не видеть, что человек только что зашёл сам.
  if exists (
    select 1 from public.room_members m
     where m.room_code = p_code and m.user_id = p_friend
  ) then
    return;
  end if;

  insert into public.notifications_outbox (user_id, kind, payload, dedupe_key)
  values (p_friend, 'room_invite',
          jsonb_build_object('from', v_me, 'code', p_code),
          'room_invite:' || p_friend::text || ':' || p_code)
  on conflict do nothing;
end;
$$;

revoke all on function public.invite_to_room(text, uuid) from public, anon;
grant execute on function public.invite_to_room(text, uuid) to authenticated;
