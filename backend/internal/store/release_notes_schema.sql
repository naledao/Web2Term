-- Schema 3: release notes and machine read state share the backend database.
-- Times are Unix milliseconds supplied by the Go service.
CREATE TABLE app_release_note (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    version      TEXT NOT NULL COLLATE BINARY
                 CHECK (length(version) BETWEEN 1 AND 32 AND version = trim(version)),
    title        TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    content_html TEXT NOT NULL,
    status       INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2)),
    published_at INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    CONSTRAINT uk_app_release_note_version UNIQUE (version),
    CONSTRAINT chk_app_release_note_published CHECK (
        status <> 1
        OR (published_at IS NOT NULL AND length(trim(content_html)) > 0)
    )
);

CREATE INDEX idx_app_release_note_published
    ON app_release_note (status, published_at DESC, id DESC);

CREATE TABLE app_release_note_read (
    machine_id      TEXT NOT NULL COLLATE BINARY CHECK (length(machine_id) = 36),
    release_note_id INTEGER NOT NULL,
    read_at         INTEGER NOT NULL,
    PRIMARY KEY (machine_id, release_note_id),
    FOREIGN KEY (release_note_id) REFERENCES app_release_note (id) ON DELETE CASCADE
);

CREATE INDEX idx_app_release_note_read_note
    ON app_release_note_read (release_note_id);
