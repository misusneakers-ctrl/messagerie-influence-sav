-- Migration du 18/09/2026 — suivi de participation aux campagnes.
-- Demandé par Luc : « un tag de participation à une campagne, et voir si elle
-- a publié : a reçu, puis a publié une fois, deux fois… ou pas du tout. »
-- But affiché : repérer et exclure celles qui reçoivent et ne publient jamais.
-- Additive : aucune donnée existante n'est touchée.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS name       TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Les campagnes déjà présentes sans nom deviennent lisibles.
UPDATE campaigns SET name = COALESCE(name, 'Campagne du ' || to_char(created_at, 'DD/MM/YYYY'));

CREATE TABLE IF NOT EXISTS campaign_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  relation_id UUID NOT NULL REFERENCES tenant_influence_relations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES influence_accounts(id) ON DELETE CASCADE,
  -- pressentie → acceptee → a_recu → a_publie / n_a_pas_publie / exclue
  status TEXT NOT NULL DEFAULT 'pressentie',
  posts_count INTEGER NOT NULL DEFAULT 0 CHECK (posts_count >= 0),
  -- [{ url, kind, at, source, added_by }] : une ligne par contenu constaté.
  posts JSONB NOT NULL DEFAULT '[]'::jsonb,
  gifting_order_id UUID,
  received_at TIMESTAMPTZ,
  first_post_at TIMESTAMPTZ,
  last_post_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, relation_id)
);

CREATE INDEX IF NOT EXISTS campaign_participants_tenant_idx  ON campaign_participants (tenant_id, campaign_id);
CREATE INDEX IF NOT EXISTS campaign_participants_relation_idx ON campaign_participants (tenant_id, relation_id);
CREATE INDEX IF NOT EXISTS campaign_participants_account_idx  ON campaign_participants (account_id);

-- Ajout du soir : raison de l'archivage (voir api/tickets/sync-instagram.js).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS archived_reason TEXT;

-- Correctif synchro (504 à 300 s) : date de dernière activité vue chez Meta,
-- pour ignorer les conversations qui n'ont pas bougé. Voir PERFORMANCE.md.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ig_conversation_updated_at TIMESTAMPTZ;
