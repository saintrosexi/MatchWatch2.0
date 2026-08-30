-- MatchWatch: страница профиля знает, дружите ли вы уже.
--
-- До этой миграции `profile_page` не возвращала ничего о дружбе, и кнопка
-- на чужой странице всегда предлагала «добавить в друзья» — включая тех,
-- кто уже в друзьях. Заявка при этом уходила в никуда (RPC просто ничего
-- не делал), а человек считал, что она не отправилась, и жал ещё раз.
--
-- Считаем здесь, а не отдельным запросом с клиента: страница и так
-- собирается одной функцией, и второй запрос ради одного слова означал бы
-- ещё одно ожидание и ещё одно состояние «пока не знаем».
--
-- Четыре состояния вместо двух. «Заявка от него» — не то же самое, что
-- «заявка от меня»: в первом случае человеку нужно принять, во втором —
-- ждать, и одинаковая кнопка на оба случая врёт в одном из них.

create or replace function public.profile_page(p_username text default null, p_user uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  base       jsonb := public.profile_page_base(p_username, p_user);
  me         uuid  := auth.uid();
  person     uuid;
  premium    boolean;
  style      text;
  fr_status  text;
  fr_by      uuid;
  friendship text := 'none';
begin
  if base is null then
    return null;
  end if;

  person := (base ->> 'id')::uuid;

  select exists (
    select 1 from public.subscriptions s
     where s.user_id = person
       and s.status = 'active'
       and s.expires_at > now()
  ) into premium;

  select p.frame into style from public.profiles p where p.id = person;

  if me is not null and me <> person then
    select f.status, f.requested_by into fr_status, fr_by
      from public.friendships f
     where f.user_id = me and f.friend_id = person
     limit 1;

    friendship := case
      when fr_status = 'accepted' then 'friends'
      when fr_status = 'pending' and fr_by = me then 'sent'
      when fr_status = 'pending' then 'incoming'
      else 'none'
    end;
  end if;

  return base || jsonb_build_object(
    'premium', premium,
    'frame', coalesce(style, 'plain'),
    'friendship', friendship
  );
end;
$$;

grant execute on function public.profile_page(text, uuid) to anon, authenticated;
