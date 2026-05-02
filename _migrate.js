// BEEEF - Script de migration Supabase (run: node _migrate.js)
const https = require('https');

const PROJECT_REF = 'enbpwvlfvqlqdhqfnlko';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVuYnB3dmxmdnFscWRocWZubGtvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njc4MzIzMCwiZXhwIjoyMDkyMzU5MjMwfQ.-hAla6eACeI7blbpQ2iew9xjJLn9MkxIiYTRoRUnjrM';

const SQL = `
-- Drop existing functions
DROP FUNCTION IF EXISTS public.deposit_balance(numeric);
DROP FUNCTION IF EXISTS public.place_bet(text,text,text,text,text,text,numeric,text);
DROP FUNCTION IF EXISTS public.settle_debate_bets(text,text,numeric);
DROP FUNCTION IF EXISTS public.cancel_participant_bet(text);
DROP FUNCTION IF EXISTS public.forfeit_participant_bet(text);

-- 1. profiles.balance
ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS balance integer NOT NULL DEFAULT 0;

-- 2. token_transactions
CREATE TABLE IF NOT EXISTS public.token_transactions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type              text        NOT NULL CHECK (type IN ('purchase', 'bet', 'win', 'refund')),
  amount            integer     NOT NULL,
  stripe_session_id text        UNIQUE,
  debate_id         text,
  metadata          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS token_transactions_user_id_idx ON public.token_transactions(user_id);
CREATE INDEX IF NOT EXISTS token_transactions_created_at_idx ON public.token_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS token_transactions_stripe_session_id_idx ON public.token_transactions(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
ALTER TABLE public.token_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own transactions" ON public.token_transactions;
CREATE POLICY "Users can view own transactions" ON public.token_transactions FOR SELECT USING (auth.uid() = user_id);

-- 3. bets
CREATE TABLE IF NOT EXISTS public.bets (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  debate_id   text          NOT NULL,
  title       text          NOT NULL DEFAULT 'Debat',
  category    text          NOT NULL DEFAULT 'general',
  cat         text          GENERATED ALWAYS AS (category) STORED,
  side        text          NOT NULL CHECK (side IN ('yes', 'no')),
  yes_label   text          NOT NULL DEFAULT 'OUI',
  no_label    text          NOT NULL DEFAULT 'NON',
  kind        text          NOT NULL DEFAULT 'market' CHECK (kind IN ('market', 'participant')),
  amt         numeric(12,2) NOT NULL CHECK (amt > 0),
  payout      numeric(12,2) NOT NULL DEFAULT 0,
  status      text          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'refunded')),
  settled_at  timestamptz,
  created_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bets_user_id_idx    ON public.bets(user_id);
CREATE INDEX IF NOT EXISTS bets_debate_id_idx  ON public.bets(debate_id);
CREATE INDEX IF NOT EXISTS bets_created_at_idx ON public.bets(created_at DESC);
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own bets" ON public.bets;
CREATE POLICY "Users can view own bets" ON public.bets FOR SELECT USING (auth.uid() = user_id);

-- 4. RPC Functions
CREATE OR REPLACE FUNCTION public.deposit_balance(p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.profiles SET balance = balance + p_amount WHERE id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.place_bet(
  p_debate_id text, p_title text, p_category text, p_side text,
  p_yes_label text, p_no_label text, p_amount numeric, p_kind text DEFAULT 'market'
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_balance numeric;
BEGIN
  SELECT balance INTO v_balance FROM public.profiles WHERE id = auth.uid() FOR UPDATE;
  IF v_balance IS NULL THEN RAISE EXCEPTION 'Profil introuvable'; END IF;
  IF v_balance < p_amount THEN RAISE EXCEPTION 'Fonds insuffisants'; END IF;
  UPDATE public.profiles SET balance = balance - p_amount WHERE id = auth.uid();
  INSERT INTO public.bets (user_id, debate_id, title, category, side, yes_label, no_label, kind, amt)
    VALUES (auth.uid(), p_debate_id, p_title, p_category, p_side, p_yes_label, p_no_label, p_kind, p_amount);
  INSERT INTO public.token_transactions (user_id, type, amount, debate_id)
    VALUES (auth.uid(), 'bet', -p_amount, p_debate_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_debate_bets(p_debate_id text, p_winner_side text, p_odds numeric)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_bet record; v_payout numeric;
  v_settled integer := 0; v_total_gain numeric := 0; v_total_loss numeric := 0;
BEGIN
  FOR v_bet IN
    SELECT * FROM public.bets WHERE user_id = auth.uid()
      AND debate_id = p_debate_id AND status = 'pending' FOR UPDATE
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
  RETURN json_build_object('settledCount', v_settled, 'totalGain', v_total_gain, 'totalLoss', v_total_loss);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_participant_bet(p_debate_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_bet record;
BEGIN
  SELECT * INTO v_bet FROM public.bets WHERE user_id = auth.uid()
    AND debate_id = p_debate_id AND kind = 'participant' AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aucune mise participant a rembourser'; END IF;
  DELETE FROM public.bets WHERE id = v_bet.id;
  UPDATE public.profiles SET balance = balance + v_bet.amt WHERE id = auth.uid();
  INSERT INTO public.token_transactions (user_id, type, amount, debate_id)
    VALUES (auth.uid(), 'refund', v_bet.amt, p_debate_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.forfeit_participant_bet(p_debate_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_bet record;
BEGIN
  SELECT * INTO v_bet FROM public.bets WHERE user_id = auth.uid()
    AND debate_id = p_debate_id AND kind = 'participant' AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aucune mise participant active'; END IF;
  UPDATE public.bets SET status = 'lost', payout = -v_bet.amt, settled_at = now() WHERE id = v_bet.id;
END;
$$;

-- ── debate_history : historique persistant des probabilites ──────────────
-- Conserve la courbe du graphique entre les redemarrages Render.
CREATE TABLE IF NOT EXISTS public.debate_history (
  id           BIGSERIAL   PRIMARY KEY,
  debate_id    TEXT        NOT NULL,
  recorded_at  BIGINT      NOT NULL,
  yes_prob     REAL        NOT NULL,
  volume       REAL        NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX  IF NOT EXISTS idx_debate_history_lookup
  ON public.debate_history (debate_id, recorded_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_debate_history_unique
  ON public.debate_history (debate_id, recorded_at);
ALTER TABLE public.debate_history ENABLE ROW LEVEL SECURITY;
DO $$debate_hist$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'debate_history' AND policyname = 'service role full access'
  ) THEN
    CREATE POLICY "service role full access"
      ON public.debate_history FOR ALL TO service_role
      USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'debate_history' AND policyname = 'anon read only'
  ) THEN
    CREATE POLICY "anon read only"
      ON public.debate_history FOR SELECT TO anon
      USING (true);
  END IF;
END $$debate_hist$$;
`;

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('🚀 BEEEF Migration — connexion à Supabase...');

  const body = JSON.stringify({ query: SQL });

  // Try Management API first
  try {
    const res = await request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);

    console.log('Status:', res.status);
    const parsed = JSON.parse(res.body);

    if (res.status === 200 || res.status === 201) {
      console.log('✅ Migration réussie!');
      console.log(JSON.stringify(parsed, null, 2));
    } else {
      console.error('❌ Erreur:', JSON.stringify(parsed, null, 2));
      console.log('\n→ Le Management API nécessite un Personal Access Token.');
      console.log('  Génère-en un sur: https://supabase.com/dashboard/account/tokens');
      console.log('  Puis remplace SERVICE_ROLE_KEY dans ce fichier par le token généré.');
    }
  } catch (err) {
    console.error('Erreur réseau:', err.message);
  }
}

main();
