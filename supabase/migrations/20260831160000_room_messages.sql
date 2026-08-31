-- MatchWatch: короткий разговор внутри комнаты.
--
-- Не мессенджер и не должен им стать. Двум людям, выбирающим кино,
-- нужно «давай это» и «а может другое» — реакция в одно касание.
-- Поле ввода есть, но оно второстепенно: реакции стоят первыми
-- и закрывают почти всё, что нужно сказать при выборе фильма.
--
-- Живёт ровно столько же, сколько комната: она удаляется сборщиком
-- через шесть часов, переписка уходит вместе с ней каскадом. Хранить
-- дольше незачем — это разговор про один вечер.
--
-- Длина ограничена базой, а не только полем ввода: клиент обходится,
-- а комната не место для простыней.

create table if not exists public.room_messages (
  id         bigserial primary key,
  room_code  text not null references public.rooms(code) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  kind       text not null default 'reaction' check (kind in ('reaction', 'text')),
  body       text not null check (char_length(body) between 1 and 200),
  created_at timestamptz not null default now()
);

create index if not exists room_messages_room_idx
  on public.room_messages (room_code, created_at desc);

alter table public.room_messages enable row level security;

-- Читают и пишут только участники. Проверка через `room_members`,
-- а не через «знает код»: код подбирается, участие — факт.
drop policy if exists room_messages_members_read on public.room_messages;
create policy room_messages_members_read on public.room_messages
  for select using (
    exists (
      select 1 from public.room_members m
       where m.room_code = room_messages.room_code and m.user_id = auth.uid()
    )
  );

drop policy if exists room_messages_members_write on public.room_messages;
create policy room_messages_members_write on public.room_messages
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.room_members m
       where m.room_code = room_messages.room_code and m.user_id = auth.uid()
    )
  );

grant select, insert on public.room_messages to authenticated;
grant usage, select on sequence public.room_messages_id_seq to authenticated;

-- Realtime: сообщение обязано появиться у второго без перезагрузки.
alter publication supabase_realtime add table public.room_messages;
