CREATE TABLE image_assets (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  original_filename TEXT NOT NULL CHECK (length(trim(original_filename)) BETWEEN 1 AND 160),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  extension TEXT NOT NULL CHECK (extension IN ('jpg', 'jpeg', 'png', 'webp', 'gif')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  original_url TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (owner_user_id, idempotency_key)
);

CREATE INDEX image_assets_owner_created_index
ON image_assets (owner_user_id, created_at DESC, id DESC);

CREATE TABLE maps (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX maps_owner_updated_index
ON maps (owner_user_id, updated_at DESC, id DESC);
