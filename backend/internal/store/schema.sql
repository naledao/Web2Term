CREATE TABLE IF NOT EXISTS user_device (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL CHECK (user_id > 0),
    device_id TEXT COLLATE BINARY NOT NULL UNIQUE CHECK (length(device_id) = 36),
    device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 100),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    online_status INTEGER NOT NULL DEFAULT 0 CHECK (online_status IN (0, 1)),
    last_connected_at TEXT,
    last_heartbeat_at TEXT,
    last_disconnected_at TEXT,
    terminal_connection_status INTEGER NOT NULL DEFAULT 0 CHECK (terminal_connection_status IN (0, 1, 2, 3)),
    terminal_session_id TEXT COLLATE BINARY UNIQUE,
    desktop_client_id TEXT COLLATE BINARY,
    terminal_requested_at TEXT,
    terminal_connected_at TEXT,
    terminal_disconnected_at TEXT,
    terminal_error TEXT CHECK (terminal_error IS NULL OR length(terminal_error) <= 512),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (terminal_connection_status NOT IN (1, 2) OR (
        terminal_session_id IS NOT NULL AND desktop_client_id IS NOT NULL AND terminal_requested_at IS NOT NULL
    ))
);

CREATE INDEX IF NOT EXISTS idx_user_device_user_online ON user_device(user_id, online_status);
CREATE INDEX IF NOT EXISTS idx_user_device_user_terminal ON user_device(user_id, terminal_connection_status);
CREATE INDEX IF NOT EXISTS idx_user_device_online_heartbeat ON user_device(online_status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_user_device_terminal_requested ON user_device(terminal_connection_status, terminal_requested_at);
