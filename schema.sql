CREATE TABLE IF NOT EXISTS users(
  id BIGSERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE NOT NULL,
  username TEXT, first_name TEXT, last_name TEXT, photo TEXT,
  rating INT DEFAULT 0, streak INT DEFAULT 0,
  is_admin BOOLEAN DEFAULT FALSE,
  last_dict_date DATE, last_check DATE, last_dict_at TIMESTAMPTZ,
  created_at DATE DEFAULT CURRENT_DATE
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS words(
  id SERIAL PRIMARY KEY,
  en TEXT NOT NULL, ru TEXT NOT NULL, note TEXT,
  difficulty INT DEFAULT 2, synonyms TEXT,
  created_by BIGINT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS activity(
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  points INT DEFAULT 0, answered INT DEFAULT 0, correct INT DEFAULT 0, dictations INT DEFAULT 0,
  PRIMARY KEY(user_id, day)
);
CREATE TABLE IF NOT EXISTS answers(
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT, word_id BIGINT, mode TEXT, correct BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dictations(
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT, total INT, correct INT, points INT, difficulty INT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS srs(
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  word_id BIGINT REFERENCES words(id) ON DELETE CASCADE,
  errors INT DEFAULT 0,
  next_review TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY(user_id, word_id)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_dict_at TIMESTAMPTZ;
ALTER TABLE words ADD COLUMN IF NOT EXISTS difficulty INT DEFAULT 2;
ALTER TABLE words ADD COLUMN IF NOT EXISTS synonyms TEXT;
ALTER TABLE dictations ADD COLUMN IF NOT EXISTS difficulty INT;
