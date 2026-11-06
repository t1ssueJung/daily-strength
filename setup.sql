begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists strength_private;
revoke all on schema strength_private from public, anon, authenticated;

create table if not exists strength_private.rooms (
  room_id uuid primary key default gen_random_uuid(),
  admin_id uuid not null unique default gen_random_uuid(),
  password_hash text not null,
  label text not null check (char_length(label) between 1 and 50)
);

create table if not exists strength_private.checks (
  room_id uuid not null references strength_private.rooms on delete cascade,
  day date not null,
  participant_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 30),
  primary key (room_id, day, participant_id)
);
create table if not exists strength_private.excluded_days (
  room_id uuid not null references strength_private.rooms on delete cascade,
  day date not null,
  primary key (room_id, day)
);
alter table strength_private.excluded_days enable row level security;
alter table strength_private.rooms enable row level security;
alter table strength_private.checks enable row level security;
revoke all on all tables in schema strength_private from public, anon, authenticated;

create or replace function public.strength_snapshot(p_room uuid, p_participant uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
  room_label text;
begin
  select label into room_label from strength_private.rooms where room_id = p_room;
  if not found then
    raise exception using errcode = 'P0002', message = 'Room not found';
  end if;

  return jsonb_build_object(
    'room', room_label,
    'today', today,
    'excluded', coalesce((
      select jsonb_agg(day order by day) from strength_private.excluded_days
      where room_id = p_room and day between today - 6 and today
    ), '[]'::jsonb),
    'names', coalesce((
      select jsonb_agg(nickname order by nickname, participant_id)
      from strength_private.checks
      where room_id = p_room and day = today
        and not exists (
          select 1 from strength_private.excluded_days where room_id = p_room and day = today
        )
    ), '[]'::jsonb),
    'mine', coalesce((
      select jsonb_agg(day order by day)
      from strength_private.checks
      where room_id = p_room and participant_id = p_participant
        and day between today - 6 and today
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.strength_set_check(
  p_room uuid, p_participant uuid, p_day date, p_name text, p_done boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
  display_name text := btrim(p_name);
begin
  perform 1 from strength_private.rooms where room_id = p_room for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Room not found';
  end if;
  if p_participant is null or p_done is null or p_day is distinct from today
     or display_name is null or char_length(display_name) not between 1 and 30
     or display_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'Invalid check';
  end if;

  if exists (select 1 from strength_private.excluded_days where room_id = p_room and day = today) then
    raise exception using errcode = '22023', message = 'Excluded day';
  end if;

  if p_done then
    insert into strength_private.checks (room_id, day, participant_id, nickname)
    values (p_room, today, p_participant, display_name)
    on conflict (room_id, day, participant_id) do update set nickname = excluded.nickname;
  else
    delete from strength_private.checks
    where room_id = p_room and day = today and participant_id = p_participant;
  end if;

  return public.strength_snapshot(p_room, p_participant);
end;
$$;

create or replace function public.strength_manage_days(
  p_admin uuid, p_password text, p_day date, p_excluded boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $
declare
  selected_room strength_private.rooms%rowtype;
  today date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
begin
  select * into selected_room from strength_private.rooms where admin_id = p_admin for update;
  if not found or p_password is null or octet_length(p_password) > 72
     or extensions.crypt(p_password, selected_room.password_hash) is distinct from selected_room.password_hash then
    raise exception using errcode = '28000', message = 'Access denied';
  end if;

  if p_day is not null and p_excluded is true then
    if p_day not between date '2000-01-01' and date '2100-12-31' then
      raise exception using errcode = '22023', message = 'Invalid date';
    end if;
    insert into strength_private.excluded_days (room_id, day)
    values (selected_room.room_id, p_day) on conflict do nothing;
  elsif p_day is not null and p_excluded is false then
    delete from strength_private.excluded_days
    where room_id = selected_room.room_id and day = p_day;
  end if;

  return jsonb_build_object(
    'room', selected_room.label,
    'roomId', selected_room.room_id,
    'today', today,
    'excluded', coalesce((
      select jsonb_agg(day order by day) from strength_private.excluded_days
      where room_id = selected_room.room_id
    ), '[]'::jsonb)
  );
end;
$;

revoke all on function public.strength_manage_days(uuid, text, date, boolean) from public, anon, authenticated;
grant execute on function public.strength_manage_days(uuid, text, date, boolean) to anon;

revoke all on function public.strength_snapshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.strength_set_check(uuid, uuid, date, text, boolean) from public, anon, authenticated;
grant execute on function public.strength_snapshot(uuid, uuid) to anon;
grant execute on function public.strength_set_check(uuid, uuid, date, text, boolean) to anon;

-- 명단 기반 체크
create table if not exists strength_private.roster (
  room_id uuid not null references strength_private.rooms on delete cascade,
  member_id uuid not null default gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 30),
  active boolean not null default true,
  primary key (room_id, member_id),
  unique (room_id, display_name)
);
create table if not exists strength_private.roster_checks (
  room_id uuid not null,
  member_id uuid not null,
  day date not null,
  primary key (room_id, member_id, day),
  foreign key (room_id, member_id) references strength_private.roster on delete cascade
);
alter table strength_private.roster enable row level security;
alter table strength_private.roster_checks enable row level security;
revoke all on all tables in schema strength_private from public, anon, authenticated;

create or replace function public.strength_roster_snapshot(p_room uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
  room_label text;
begin
  select label into room_label from strength_private.rooms where room_id = p_room;
  if not found then
    raise exception using errcode = 'P0002', message = 'Room not found';
  end if;

  return jsonb_build_object(
    'room', room_label,
    'today', today,
    'excluded', coalesce((
      select jsonb_agg(day order by day) from strength_private.excluded_days
      where room_id = p_room and day between today - 6 and today
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', roster_member.member_id, 'name', roster_member.display_name,
        'days', coalesce((
          select jsonb_agg(checks.day order by checks.day)
          from strength_private.roster_checks checks
          where checks.room_id = p_room and checks.member_id = roster_member.member_id
            and checks.day between today - 6 and today
            and not exists (
              select 1 from strength_private.excluded_days excluded
              where excluded.room_id = p_room and excluded.day = checks.day
            )
        ), '[]'::jsonb)
      ) order by roster_member.display_name)
      from strength_private.roster roster_member where roster_member.room_id = p_room and roster_member.active
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.strength_roster_set_check(
  p_room uuid, p_member uuid, p_day date, p_done boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
begin
  perform 1 from strength_private.rooms where room_id = p_room for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Room not found';
  end if;
  if p_day is null or p_done is null or p_day not between today - 6 and today
     or not exists (
       select 1 from strength_private.roster
       where room_id = p_room and member_id = p_member and active
     )
     or exists (
       select 1 from strength_private.excluded_days where room_id = p_room and day = p_day
     ) then
    raise exception using errcode = '22023', message = 'Unavailable check';
  end if;

  if p_done then
    insert into strength_private.roster_checks (room_id, member_id, day)
    values (p_room, p_member, p_day) on conflict do nothing;
  else
    delete from strength_private.roster_checks
    where room_id = p_room and member_id = p_member and day = p_day;
  end if;
  return public.strength_roster_snapshot(p_room);
end;
$$;

create or replace function public.strength_manage_roster(
  p_admin uuid, p_password text, p_names text[], p_remove uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_room strength_private.rooms%rowtype;
begin
  select * into selected_room from strength_private.rooms where admin_id = p_admin for update;
  if not found or p_password is null or octet_length(p_password) > 72
     or extensions.crypt(p_password, selected_room.password_hash) is distinct from selected_room.password_hash then
    raise exception using errcode = '28000', message = 'Access denied';
  end if;

  if p_names is not null then
    if cardinality(p_names) > 100 or exists (
      select 1 from unnest(p_names) as submitted(name)
      where name is null or char_length(btrim(name)) not between 1 and 30 or name ~ '[[:cntrl:]]'
    ) then
      raise exception using errcode = '22023', message = 'Invalid names';
    end if;

    -- 새로 등록된 이름에만 이전 버전의 같은 이름 기록을 연결합니다.
    with registered as (
      insert into strength_private.roster (room_id, display_name)
      select selected_room.room_id, btrim(name) from unnest(p_names) as submitted(name)
      on conflict do nothing returning member_id, display_name
    )
    insert into strength_private.roster_checks (room_id, member_id, day)
    select selected_room.room_id, registered.member_id, previous.day
    from registered join strength_private.checks previous
      on previous.room_id = selected_room.room_id and previous.nickname = registered.display_name
    on conflict do nothing;

    update strength_private.roster
    set active = true
    where room_id = selected_room.room_id and not active
      and display_name in (select btrim(name) from unnest(p_names) as submitted(name));
  end if;

  if p_remove is not null then
    update strength_private.roster set active = false
    where room_id = selected_room.room_id and member_id = p_remove;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('id', member_id, 'name', display_name) order by display_name)
    from strength_private.roster where room_id = selected_room.room_id and active
  ), '[]'::jsonb);
end;
$$;

-- 브라우저마다 이름을 입력하던 이전 체크 API는 사용을 종료합니다.
revoke all on function public.strength_snapshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.strength_set_check(uuid, uuid, date, text, boolean) from public, anon, authenticated;
revoke all on function public.strength_roster_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.strength_roster_set_check(uuid, uuid, date, boolean) from public, anon, authenticated;
revoke all on function public.strength_manage_roster(uuid, text, text[], uuid) from public, anon, authenticated;
grant execute on function public.strength_roster_snapshot(uuid) to anon;
grant execute on function public.strength_roster_set_check(uuid, uuid, date, boolean) to anon;
grant execute on function public.strength_manage_roster(uuid, text, text[], uuid) to anon;

insert into strength_private.rooms (label, password_hash)
select '우리 반', extensions.crypt('123456!', extensions.gen_salt('bf', 10))
where not exists (select 1 from strength_private.rooms);

notify pgrst, 'reload schema';
commit;

select label, room_id, admin_id from strength_private.rooms order by label;


