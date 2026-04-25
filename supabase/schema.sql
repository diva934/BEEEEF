create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  username text not null,
  balance numeric(12,2) not null default 0,
  region text,
  langs text[] not null default '{}',
  phone text not null default '',
  two_factor_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create table if not exists public.bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  debate_id text not null,
  title text not null,
  category text not null default 'general',
  cat text not null default 'general',
  side text not null check (side in ('yes', 'no')),
  yes_label text not null default 'OUI',
  no_label text not null default 'NON',
  kind text not null default 'market' check (kind in ('market', 'participant')),
  amt numeric(12,2) not null check (amt > 0),
  status text not null default 'pending' check (status in ('pending', 'won', 'lost')),
  payout numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

alter table public.profiles
alter column balance set default 0;

create index if not exists idx_bets_user_created_at on public.bets(user_id, created_at desc);
create index if not exists idx_bets_user_debate_status on public.bets(user_id, debate_id, status);

alter table public.profiles enable row level security;
alter table public.bets enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.bets to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles
for select
to authenticated
using (id = (select auth.uid()));

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles
for insert
to authenticated
with check (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists bets_select_own on public.bets;
create policy bets_select_own
on public.bets
for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists bets_insert_own on public.bets;
create policy bets_insert_own
on public.bets
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists bets_update_own on public.bets;
create policy bets_update_own
on public.bets
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists bets_delete_own on public.bets;
create policy bets_delete_own
on public.bets
for delete
to authenticated
using (user_id = (select auth.uid()));

create or replace function public.deposit_balance(p_amount numeric)
returns numeric
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_amount numeric(12,2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_balance numeric(12,2);
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if v_amount < 100 then
    raise exception 'Nombre de points invalide';
  end if;

  update public.profiles
     set balance = round((balance + v_amount)::numeric, 2)
   where id = auth.uid()
   returning balance into v_balance;

  if not found then
    raise exception 'Profil introuvable';
  end if;

  return v_balance;
end;
$$;

create or replace function public.place_bet(
  p_debate_id text,
  p_title text,
  p_category text,
  p_side text,
  p_yes_label text,
  p_no_label text,
  p_amount numeric,
  p_kind text default 'market'
)
returns public.bets
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_amount numeric(12,2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_category text := coalesce(nullif(trim(p_category), ''), 'general');
  v_kind text := case when p_kind = 'participant' then 'participant' else 'market' end;
  v_bet public.bets;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(trim(p_debate_id), '') = '' then
    raise exception 'Debat manquant';
  end if;

  if p_side not in ('yes', 'no') then
    raise exception 'Camp invalide';
  end if;

  if v_amount <= 0 then
    raise exception 'Nombre de points invalide';
  end if;

  if v_kind = 'participant' and exists (
    select 1
      from public.bets
     where user_id = auth.uid()
       and debate_id = p_debate_id
       and kind = 'participant'
       and status = 'pending'
  ) then
    raise exception 'Participation deja en cours';
  end if;

  update public.profiles
     set balance = round((balance - v_amount)::numeric, 2)
   where id = auth.uid()
     and balance >= v_amount;

  if not found then
    raise exception 'Points insuffisants';
  end if;

  insert into public.bets (
    user_id,
    debate_id,
    title,
    category,
    cat,
    side,
    yes_label,
    no_label,
    kind,
    amt
  )
  values (
    auth.uid(),
    p_debate_id,
    coalesce(nullif(trim(p_title), ''), 'Debat'),
    v_category,
    v_category,
    p_side,
    coalesce(nullif(trim(p_yes_label), ''), 'OUI'),
    coalesce(nullif(trim(p_no_label), ''), 'NON'),
    v_kind,
    v_amount
  )
  returning * into v_bet;

  return v_bet;
end;
$$;

create or replace function public.settle_debate_bets(
  p_debate_id text,
  p_winner_side text,
  p_odds numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_odds numeric(12,2) := round(coalesce(p_odds, 0)::numeric, 2);
  v_settled_count integer := 0;
  v_total_gain numeric(12,2) := 0;
  v_total_loss numeric(12,2) := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(trim(p_debate_id), '') = '' then
    raise exception 'Debat manquant';
  end if;

  if p_winner_side not in ('yes', 'no') then
    raise exception 'Vainqueur invalide';
  end if;

  if v_odds <= 1 then
    raise exception 'Cote invalide';
  end if;

  with affected as (
    update public.bets
       set status = case when side = p_winner_side then 'won' else 'lost' end,
           payout = case
             when side = p_winner_side then round((amt * v_odds)::numeric, 2)
             else round((-amt)::numeric, 2)
           end,
           settled_at = now()
     where user_id = auth.uid()
       and debate_id = p_debate_id
       and status = 'pending'
     returning side, amt, payout
  )
  select
    count(*),
    coalesce(sum(case when side = p_winner_side then payout else 0 end), 0),
    coalesce(sum(case when side <> p_winner_side then amt else 0 end), 0)
    into v_settled_count, v_total_gain, v_total_loss
  from affected;

  if v_settled_count > 0 then
    update public.profiles
       set balance = round((balance + v_total_gain)::numeric, 2)
     where id = auth.uid();
  end if;

  return jsonb_build_object(
    'debateId', p_debate_id,
    'settledCount', v_settled_count,
    'totalGain', round(v_total_gain::numeric, 2),
    'totalLoss', round(v_total_loss::numeric, 2)
  );
end;
$$;

create or replace function public.cancel_participant_bet(p_debate_id text)
returns numeric
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_amount numeric(12,2);
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.bets
   where id = (
     select id
       from public.bets
      where user_id = auth.uid()
        and debate_id = p_debate_id
        and kind = 'participant'
        and status = 'pending'
      order by created_at desc
      limit 1
   )
   returning amt into v_amount;

  if v_amount is null then
    raise exception 'Aucune mise participant a rembourser';
  end if;

  update public.profiles
     set balance = round((balance + v_amount)::numeric, 2)
   where id = auth.uid();

  return v_amount;
end;
$$;

create or replace function public.forfeit_participant_bet(p_debate_id text)
returns numeric
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_amount numeric(12,2);
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.bets
     set status = 'lost',
         payout = round((-amt)::numeric, 2),
         settled_at = now()
   where id = (
     select id
       from public.bets
      where user_id = auth.uid()
        and debate_id = p_debate_id
        and kind = 'participant'
        and status = 'pending'
      order by created_at desc
      limit 1
   )
   returning amt into v_amount;

  if v_amount is null then
    raise exception 'Aucune mise participant a perdre';
  end if;

  return v_amount;
end;
$$;

grant execute on function public.deposit_balance(numeric) to authenticated;
grant execute on function public.place_bet(text, text, text, text, text, text, numeric, text) to authenticated;
grant execute on function public.settle_debate_bets(text, text, numeric) to authenticated;
grant execute on function public.cancel_participant_bet(text) to authenticated;
grant execute on function public.forfeit_participant_bet(text) to authenticated;
