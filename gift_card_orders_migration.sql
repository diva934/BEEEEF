-- ─────────────────────────────────────────────────────────────
--  BEEEF — gift_card_orders table
--  Run once in Supabase → SQL Editor
-- ─────────────────────────────────────────────────────────────

create table if not exists gift_card_orders (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  email             text        not null,
  gift_card_brand   text        not null,
  gift_card_value   integer     not null,          -- face value in EUR (10, 20, 50 …)
  points_cost       integer     not null,           -- points deducted
  provider          text        not null default 'tremendous',
  provider_order_id text,                           -- Tremendous order ID once placed
  status            text        not null default 'pending'
                                check (status in (
                                  'pending',
                                  'points_deducted',
                                  'gift_sent',
                                  'failed',
                                  'refunded_points'
                                )),
  idempotency_key   text        unique,             -- prevents double processing
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────
create index if not exists gift_card_orders_user_id_idx
  on gift_card_orders (user_id);

create index if not exists gift_card_orders_status_idx
  on gift_card_orders (status);

create index if not exists gift_card_orders_idempotency_key_idx
  on gift_card_orders (idempotency_key)
  where idempotency_key is not null;

-- ── Row-level security ────────────────────────────────────────
alter table gift_card_orders enable row level security;

-- Users can only see their own orders
create policy "Users read own orders"
  on gift_card_orders for select
  using (auth.uid() = user_id);

-- Only the service role (backend) can insert / update
-- (no INSERT/UPDATE policy for authenticated role → backend uses service role key)
