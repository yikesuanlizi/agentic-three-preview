CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS rag_documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('asset', 'asset_view', 'template', 'wiki', 'skill', 'repair_note')),
  source_kind TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  view TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'B')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_kind ON rag_documents(kind);
CREATE INDEX IF NOT EXISTS idx_rag_documents_source ON rag_documents(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_tags ON rag_documents USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_rag_documents_metadata ON rag_documents USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_rag_documents_search ON rag_documents USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_rag_documents_title_trgm ON rag_documents USING GIN(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_rag_documents_body_trgm ON rag_documents USING GIN(body gin_trgm_ops);

CREATE TABLE IF NOT EXISTS rag_ingest_runs (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  document_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS aircraft_asset_views (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  view TEXT NOT NULL,
  image_path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aircraft_asset_views_asset ON aircraft_asset_views(asset_id);
CREATE INDEX IF NOT EXISTS idx_aircraft_asset_views_view ON aircraft_asset_views(view);
