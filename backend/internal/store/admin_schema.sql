-- Schema 5: account activity and an audit trail for administrator actions.
-- Times are Unix milliseconds supplied by the Go service.
ALTER TABLE user_account ADD COLUMN last_login_at INTEGER;

CREATE TABLE admin_audit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id  INTEGER NOT NULL,
    target_user_id INTEGER,
    action         TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
    detail         TEXT NOT NULL DEFAULT '{}' CHECK (length(detail) <= 4000),
    created_at     INTEGER NOT NULL
);

-- Kept without foreign keys so the trail survives if an account row is ever removed.
CREATE INDEX idx_admin_audit_target ON admin_audit_log (target_user_id, created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_created ON admin_audit_log (created_at DESC, id DESC);
