-- Migration du 18/09/2026 — coordonnées et pointure dans la fiche influence.
-- Additive : aucune donnée existante n'est touchée, aucune colonne supprimée.
ALTER TABLE influence_accounts
  ADD COLUMN IF NOT EXISTS address     TEXT,
  ADD COLUMN IF NOT EXISTS postal_code TEXT,
  ADD COLUMN IF NOT EXISTS phone       TEXT,
  ADD COLUMN IF NOT EXISTS shoe_size   TEXT;
