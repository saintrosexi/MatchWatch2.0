-- MatchWatch: витрина — платная целиком.
--
-- Без подписки страница собирается по умолчанию: серый акцент, без
-- обложки, без закреплённых, без фактуры. Аватар, ник, статистика,
-- любимое и темы остаются — это не оформление, а то, что человек и так
-- о себе сказал решениями.
--
-- Снимается оформление ЗДЕСЬ, а не на клиенте. Оно существует затем,
-- чтобы его видели другие: клиентская проверка убрала бы его только
-- у владельца, а гостям страница по-прежнему приезжала бы украшенной.
--
-- Сами настройки в таблице не трогаются. Подписка вернётся — вернётся
-- и оформление, настраивать заново ничего не придётся.

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

  if not premium then
    base := base
      || jsonb_build_object(
           'pinned', '[]'::jsonb,
           'hero', null,
           'accent', 'plain'
         );
    style := 'plain';
  end if;

  return base || jsonb_build_object(
    'premium', premium,
    'frame', coalesce(style, 'plain'),
    'friendship', friendship
  );
end;
$$;

grant execute on function public.profile_page(text, uuid) to anon, authenticated;
