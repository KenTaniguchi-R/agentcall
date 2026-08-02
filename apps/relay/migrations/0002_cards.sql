CREATE TABLE cards (
  org TEXT NOT NULL,
  handle TEXT NOT NULL,
  card_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org, handle)
);
