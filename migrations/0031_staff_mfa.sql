-- P0: staff TOTP multi-factor authentication.
-- secret_enc is AES-GCM ciphertext (key from a Worker secret); the plaintext secret is never stored.
-- enabled_at stays NULL until the user proves possession by entering a valid code.
-- last_used_step is the replay guard: a TOTP time step can be accepted at most once.
-- recovery_hashes is a JSON array of salted SHA-256 hashes; each code works once.
CREATE TABLE IF NOT EXISTS staff_mfa (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  enabled_at TEXT,
  last_used_step INTEGER,
  recovery_hashes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A session is only fully authenticated for MFA-required users once mfa_at is set.
ALTER TABLE sessions ADD COLUMN mfa_at TEXT;
