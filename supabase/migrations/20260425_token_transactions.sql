-- ═══════════════════════════════════════════════════════════════
--  BEEEF — Token transactions migration
--  Run this in Supabase > SQL Editor (one-time)
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Ensure profiles.balance column exists ─────────────────
-- (It should already exist from your initial schema; this is a safety net)
ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS balance integer NOT NULL DEFAULT 0;

-- ── 2. token_transactions table ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.token_transactions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type              text        NOT NULL CHECK (type IN ('purchase', 'bet', 'win', 'refund')),
  amount            integer     NOT NULL,                -- positive for credit, negative for debit
  stripe_session_id text        UNIQUE,                 -- NULL for non-Stripe transactions; UNIQUE enforces idempotence
  debate_id         text,                               -- optional, for bet/win/refund rows
  metadata          jsonb,                              -- arbitrary extra data (packId, email, etc.)
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS token_transactions_user_id_idx
  ON public.token_transactions(user_id);

CREATE INDEX IF NOT EXISTS token_transactions_created_at_idx
  ON public.token_transactions(created_at DESC);

-- stripe_session_id already has an implicit unique index; add explicit one for lookups
CREATE INDEX IF NOT EXISTS token_transactions_stripe_session_id_idx
  ON public.token_transactions(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- ── 4. Row-Level Security ─────────────────────────────────────
ALTER TABLE public.token_transactions ENABLE ROW LEVEL SECURITY;

-- Users can only read their own transactions
CREATE POLICY "Users can view own transactions"
  ON public.token_transactions
  FOR SELECT
  USING (auth.uid() = user_id);

-- Only service role can insert/update (webhook uses service role key)
-- No INSERT policy for authenticated users — they cannot credit themselves
-- (The service role bypasses RLS automatically)

-- ── 5. bets table ─────────────────────────────────────────────
-- If you do not have a bets table yet, create it here.
-- If it already exists, this block is a no-op.
CREATE TABLE IF NOT EXISTS public.bets (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  debate_id   text        NOT NULL,
  title       text        NOT NULL DEFAULT 'Debat',
  category    text        NOT NULL DEFAULT 'general',
  cat         text        GENERATED ALWAYS AS (category) STORED,
  side        text        NOT NULL CHECK (side IN ('yes', 'no')),
  yes_label   text        NOT NULL DEFAULT 'OUI',
  no_label    text        NOT NULL DEFAULT 'NON',
  kind        text        NOT NULL DEFAULT 'market' CHECK (kind IN ('market', 'participant')),
  amt         numeric(12,2) NOT NULL CHECK (amt > 0),
  payout      numeric(12,2) NOT NULL DEFAULT 0,
  status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'refunded')),
  settled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bets_user_id_idx       ON public.bets(user_id);
CREATE INDEX IF NOT EXISTS bets_debate_id_idx     ON public.bets(debate_id);
CREATE INDEX IF NOT EXISTS bets_created_at_idx    ON public.bets(created_at DESC);

ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own bets"
  ON public.bets FOR SELECT
  USING (auth.uid() = user_id);

-- ── 6. Supabase RPC functions ─────────────────────────────────
-- These are called from the backend via callRpc().
-- They run as SECURITY DEFINER so they can modify balance atomically.

-- deposit_balance: credits arbitrary amount (called by admin/webhook path — not exposed to users)
CREATE OR REPLACE FUNCTION public.deposit_balance(p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.profiles
  SET balance = balance + p_amount
  WHERE id = auth.uid();
END;
$$;

-- place_bet: debits balance + inserts bet atomically
CREATE OR REPLACE FUNCTION public.place_bet(
  p_debate_id  text,
  p_title      text,
  p_category   text,
  p_side       text,
  p_yes_label  text,
  p_no_label   text,
  p_amount     numeric,
  p_kind       text DEFAULT 'market'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_balance numeric;
BEGIN
  SELECT balance INTO v_balance FROM public.profiles WHERE id = auth.uid() FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Profil introuvable';
  END IF;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Fonds insuffisants';
  END IF;

  UPDATE public.profiles SET balance = balance - p_amount WHERE id = auth.uid();

  INSERT INTO public.bets (user_id, debate_id, title, category, side, yes_label, no_label, kind, amt)
  VALUES (auth.uid(), p_debate_id, p_title, p_category, p_side, p_yes_label, p_no_label, p_kind, p_amount);

  INSERT INTO public.token_transactions (user_id, type, amount, debate_id)
  VALUES (auth.uid(), 'bet', -p_amount, p_debate_id);
END;
$$;

-- settle_debate_bets: marks bets won/lost + credits winners
CREATE OR REPLACE FUNCTION public.settle_debate_bets(
  p_debate_id   text,
  p_winner_side text,
  p_odds        numeric
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bet         record;
  v_payout      numeric;
  v_settled     integer := 0;
  v_total_gain  numeric := 0;
  v_total_loss  numeric := 0;
BEGIN
  FOR v_bet IN
    SELECT * FROM public.bets
    WHERE user_id = auth.uid()
      AND debate_id = p_debate_id
      AND status = 'pending'
    FOR UPDATE
  LOOP
    IF v_bet.side = p_winner_side THEN
      v_payout := round(v_bet.amt * p_odds, 2);
      UPDATE public.bets SET status = 'won', payout = v_payout, settled_at = now() WHERE id = v_bet.id;
      UPDATE public.profiles SET balance = balance + v_payout WHERE id = auth.uid();
      INSERT INTO public.token_transactions (user_id, type, amount, debate_id)
        VALUES (auth.uid(), 'win', v_payout, p_debate_id);
      v_total_gain := v_total_gain + v_payout;
    ELSE
      UPDATE public.bets SET status = 'lost', payout = -v_bet.amt, settled_at = now() WHERE id = v_bet.id;
      v_total_loss := v_total_loss + v_bet.amt;
    END IF;
    v_settled := v_settled + 1;
  END LOOP;

  RETURN json_build_object(
    'settledCount', v_settled,
    'totalGain',    v_total_gain,
    'totalLoss',    v_total_loss
  );
END;
$$;

-- cancel_participant_bet: refunds participant's pending bet
CREATE OR REPLACE FUNCTION public.cancel_participant_bet(p_debate_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bet record;
BEGIN
  SELECT * INTO v_bet FROM public.bets
  WHERE user_id = auth.uid()
    AND debate_id = p_debate_id
    AND kind = 'participant'
    AND status = 'pending'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aucune mise participant a rembourser';
  END IF;

  DELETE FROM public.bets WHERE id = v_bet.id;
  UPDATE public.profiles SET balance = balance + v_bet.amt WHERE id = auth.uid();
  INSERT INTO public.token_transactions (user_id, type, amount, debate_id)
    VALUES (auth.uid(), 'refund', v_bet.amt, p_debate_id);
END;
$$;

-- forfeit_participant_bet: marks participant bet as lost (no refund)
CREATE OR REPLACE FUNCTION public.forfeit_participant_bet(p_debate_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bet record;
BEGIN
  SELECT * INTO v_bet FROM public.bets
  WHERE user_id = auth.uid()
    AND debate_id = p_debate_id
    AND kind = 'participant'
    AND status = 'pending'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aucune mise participant active';
  END IF;

  UPDATE public.bets
  SET status = 'lost', payout = -v_bet.amt, settled_at = now()
  WHERE id = v_bet.id;
END;
$$;
