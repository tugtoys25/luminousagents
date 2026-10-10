-- Sprint 16: unified email + password authentication for staff and buyers.
-- Builds on 0014 (users.password_hash) and 0015 (password_reset_tokens). Forward-only: 0014/0015 are untouched.
ALTER TABLE users ADD COLUMN password_updated_at TEXT;
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'buyer';
-- Sessions created by the Sprint 14/15 staff login have no type; mark them as staff.
UPDATE sessions SET session_type = 'staff' WHERE user_id IN (SELECT id FROM users WHERE user_type = 'staff');
ALTER TABLE password_reset_tokens ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reset';
