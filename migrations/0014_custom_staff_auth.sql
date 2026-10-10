-- Custom staff email/password authentication. Existing staff can be provisioned
-- through the one-time bootstrap token if their password_hash is still NULL.
ALTER TABLE users ADD COLUMN password_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_users_staff_auth ON users(user_type, status, email);
