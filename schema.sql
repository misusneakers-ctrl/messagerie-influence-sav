-- Messagerie / Influence / SAV — noyau multi-tenant
-- Révision du 9 septembre 2026 : sépare identité influence (partagée) et
-- relation par marque (modèle "agence"), ajoute la lecture Shopify pour le SAV.
-- Isolation entre marques : Row Level Security Postgres, pas seulement le code applicatif.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- TENANTS (registre des marques — pas de RLS ici, c'est la table racine)
-- ============================================================
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,              -- 'bbp', 'misu'
  name TEXT NOT NULL,
  myshopify_domain TEXT,
  plan TEXT NOT NULL DEFAULT 'internal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenants (slug, name, myshopify_domain) VALUES
  ('bbp', 'Bons Baisers de Paname', 'bons-baisers.myshopify.com'),
  ('misu', 'Misü', 'misu-sneakers.myshopify.com')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- CREDENTIALS PAR TENANT (chiffrées applicativement, AES-256-GCM)
-- type: 'meta_instagram' | 'shopify_readonly' | 'shopify_webhook_secret'
-- ============================================================
CREATE TABLE tenant_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  -- valeur chiffrée : iv + auth_tag + ciphertext, encodés base64, séparés par ':'
  encrypted_value TEXT NOT NULL,
  -- métadonnées non sensibles utiles pour router sans déchiffrer
  -- ex. pour meta_instagram : { "ig_business_account_id": "..." }
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, type)
);
ALTER TABLE tenant_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_credentials
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ============================================================
-- TAGS (catalogue partagé — les libellés existent une seule fois,
-- leur application à un ticket ou une relation influence est, elle, scopée)
-- ============================================================
CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT UNIQUE NOT NULL,
  category TEXT   -- libre : 'univers', 'statut', 'droit', etc. — informatif seulement
);

INSERT INTO tags (label) VALUES
  ('mode'), ('sneakers'), ('lifestyle'), ('maman'), ('voyage'), ('Paris'),
  ('humour'), ('mariage'), ('vintage'), ('UGC'), ('affiliation'), ('gifting'),
  ('contenu organique'), ('contenu publicitaire'), ('TikTok Shop'),
  ('forte priorité'), ('à relancer'), ('droits à négocier'),
  ('déjà cliente'), ('déjà contactée')
ON CONFLICT (label) DO NOTHING;

-- ============================================================
-- INFLUENCE — IDENTITÉ PARTAGÉE (modèle "agence")
-- Pas de tenant_id, pas de RLS : Luc opère les deux marques,
-- ce n'est pas un cloisonnement multi-client façon SaaS.
-- ============================================================
CREATE TABLE influence_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  instagram_handle TEXT,
  tiktok_handle TEXT,
  instagram_url TEXT,
  tiktok_url TEXT,
  email TEXT,
  city TEXT,
  country TEXT,
  follower_count INTEGER,
  recent_views_observed INTEGER,
  engagement_observed NUMERIC,
  editorial_universe TEXT,
  visible_brands_collabs TEXT,
  evidence_notes TEXT,
  -- Correctif 2026-09-15 (panneau "qualite influenceuse", demande par Luc) :
  -- champs alimentes soit a la main (email/age/story sauvegardee, jamais
  -- exposes par Meta pour un compte tiers), soit plus tard automatiquement
  -- une fois la Business Discovery API branchee (photo, followers,
  -- engagement deja couverts plus haut, tags frequents, date du dernier
  -- sync), en attendant editables a la main.
  profile_picture_url TEXT,
  age INTEGER,
  saved_story_url TEXT,
  frequent_tags TEXT[],
  instagram_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX influence_accounts_ig_handle_idx
  ON influence_accounts (lower(instagram_handle))
  WHERE instagram_handle IS NOT NULL;
CREATE UNIQUE INDEX influence_accounts_tiktok_handle_idx
  ON influence_accounts (lower(tiktok_handle))
  WHERE tiktok_handle IS NOT NULL;

-- ============================================================
-- INFLUENCE — RELATION PAR MARQUE (RLS par tenant)
-- Score explicable sur 100, plafonné par sous-critère, calculé par la base.
-- ============================================================
CREATE TABLE tenant_influence_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES influence_accounts(id) ON DELETE CASCADE,
  relationship_status TEXT,
  first_contact_at TIMESTAMPTZ,
  last_exchange_at TIMESTAMPTZ,
  contact_source TEXT,
  brand_history TEXT,
  orders_or_gifting JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_received JSONB NOT NULL DEFAULT '[]'::jsonb,
  usage_rights TEXT,
  attributed_revenue NUMERIC NOT NULL DEFAULT 0,
  next_action TEXT,
  owner TEXT,
  score_brand_fit INTEGER CHECK (score_brand_fit BETWEEN 0 AND 25) DEFAULT 0,
  score_content_quality INTEGER CHECK (score_content_quality BETWEEN 0 AND 20) DEFAULT 0,
  score_engagement INTEGER CHECK (score_engagement BETWEEN 0 AND 20) DEFAULT 0,
  score_audience_relevance INTEGER CHECK (score_audience_relevance BETWEEN 0 AND 15) DEFAULT 0,
  score_reliability INTEGER CHECK (score_reliability BETWEEN 0 AND 10) DEFAULT 0,
  score_commercial_potential INTEGER CHECK (score_commercial_potential BETWEEN 0 AND 10) DEFAULT 0,
  score_total INTEGER GENERATED ALWAYS AS (
    coalesce(score_brand_fit, 0) + coalesce(score_content_quality, 0) +
    coalesce(score_engagement, 0) + coalesce(score_audience_relevance, 0) +
    coalesce(score_reliability, 0) + coalesce(score_commercial_potential, 0)
  ) STORED,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_id)
);
ALTER TABLE tenant_influence_relations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_influence_relations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE relation_tags (
  relation_id UUID NOT NULL REFERENCES tenant_influence_relations(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (relation_id, tag_id)
);
ALTER TABLE relation_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON relation_tags
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ============================================================
-- TICKETS (RLS par tenant)
-- ============================================================
CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,                  -- 'instagram' | 'email'
  category TEXT NOT NULL DEFAULT 'Autre', -- Influence, SAV, Partenariat, Presse, B2B, Commande, Livraison, Retour, Paiement, Autre
  status TEXT NOT NULL DEFAULT 'a_traiter', -- a_traiter, en_attente_client, en_attente_interne, a_valider, resolu, erreur
  contact_name TEXT,
  contact_handle TEXT,
  contact_email TEXT,
  related_order_number TEXT,
  influence_relation_id UUID REFERENCES tenant_influence_relations(id),
  external_thread_id TEXT,                -- id du fil côté Instagram/email
  summary TEXT,
  assigned_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tickets
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE UNIQUE INDEX tickets_external_thread_idx
  ON tickets (tenant_id, channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;

CREATE TABLE ticket_tags (
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, tag_id)
);
ALTER TABLE ticket_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_tags
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ============================================================
-- MESSAGES DE TICKET — workflow draft -> validated -> sent forcé côté API
-- ============================================================
CREATE TABLE ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,                -- 'inbound' | 'outbound'
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received', -- inbound: 'received' ; outbound: 'draft' -> 'validated' -> 'sent' (ou 'rejected')
  validated_by TEXT,
  validated_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  external_message_id TEXT,
  idempotency_key TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_status CHECK (
    (direction = 'inbound' AND status = 'received') OR
    (direction = 'outbound' AND status IN ('draft', 'validated', 'sent', 'rejected'))
  )
);
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_messages
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE UNIQUE INDEX ticket_messages_idempotency_idx
  ON ticket_messages (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- SEGMENTS ET CAMPAGNES (RLS par tenant)
-- ============================================================
CREATE TABLE segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON segments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  segment_id UUID REFERENCES segments(id),
  objective TEXT,
  offer TEXT,
  budget_or_product TEXT,
  message_template TEXT,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft, pending_validation, sent, stopped
  sent_at TIMESTAMPTZ,
  response_rate NUMERIC,
  collaborations_obtained INTEGER,
  cost NUMERIC,
  content_obtained TEXT,
  attributed_revenue NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaigns
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ============================================================
-- JOURNAL D'AUDIT (RLS par tenant)
-- ============================================================
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
