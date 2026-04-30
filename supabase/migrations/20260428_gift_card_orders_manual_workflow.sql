-- BEEEF — manual gift card workflow
-- Run after the original gift_card_orders table exists.

alter table if exists public.gift_card_orders
  add column if not exists gift_code text,
  add column if not exists admin_note text,
  add column if not exists processed_by_admin_id uuid references auth.users(id) on delete set null,
  add column if not exists status_history jsonb not null default '[]'::jsonb,
  add column if not exists reserved_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists refunded_at timestamptz;

update public.gift_card_orders
set status = case
  when status = 'pending' then 'pending_review'
  when status = 'points_deducted' then 'points_reserved'
  when status = 'refunded_points' then 'points_refunded'
  else status
end
where status in ('pending', 'points_deducted', 'refunded_points');

alter table public.gift_card_orders
  alter column provider set default 'manual_admin';

update public.gift_card_orders
set provider = 'manual_admin'
where provider is null or provider = 'tremendous';

update public.gift_card_orders
set status_history = jsonb_build_array(
  jsonb_build_object(
    'status', status,
    'at', coalesce(updated_at, created_at, now()),
    'source', 'migration'
  )
)
where coalesce(jsonb_array_length(status_history), 0) = 0;

do $$
declare
  v_constraint_name text;
begin
  select conname
  into v_constraint_name
  from pg_constraint
  where conrelid = 'public.gift_card_orders'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%';

  if v_constraint_name is not null then
    execute format('alter table public.gift_card_orders drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.gift_card_orders
  add constraint gift_card_orders_status_check
  check (status in (
    'pending_review',
    'points_reserved',
    'gift_ready',
    'gift_sent',
    'failed',
    'points_refunded'
  ));
