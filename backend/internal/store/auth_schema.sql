CREATE TABLE user_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL UNIQUE,
    email TEXT COLLATE NOCASE NOT NULL UNIQUE,
    nickname TEXT NOT NULL,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- New local accounts must never inherit orphan device IDs from the external
-- identity provider used by schema 1. Import/mapping is an explicit operation.
INSERT INTO sqlite_sequence(name, seq)
SELECT 'user_account', COALESCE(MAX(user_id), 0) FROM user_device;

CREATE TABLE login_code (
    email TEXT COLLATE NOCASE PRIMARY KEY,
    code_hash BLOB NOT NULL,
    expires_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_started INTEGER NOT NULL,
    send_count INTEGER NOT NULL
);
CREATE INDEX idx_login_code_expiry ON login_code(expires_at);
