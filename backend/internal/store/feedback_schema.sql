-- Schema 4: text-only feedback submitted by signed-in desktop users.
-- Times are Unix milliseconds supplied by the Go service.
CREATE TABLE app_feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    machine_id  TEXT COLLATE BINARY CHECK (machine_id IS NULL OR length(machine_id) = 36),
    category    TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'improvement', 'other')),
    content     TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 5000),
    email       TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1),
    app_version TEXT NOT NULL DEFAULT '' CHECK (length(app_version) <= 32),
    platform    TEXT NOT NULL DEFAULT '' CHECK (length(platform) <= 64),
    status      INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2, 3)),
    admin_note  TEXT CHECK (admin_note IS NULL OR length(admin_note) <= 2000),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user_account (id) ON DELETE CASCADE
);

-- The user's own history, newest first; also backs the per-user daily quota.
CREATE INDEX idx_app_feedback_user
    ON app_feedback (user_id, created_at DESC, id DESC);

-- Administration: filter by status, newest first.
CREATE INDEX idx_app_feedback_status
    ON app_feedback (status, created_at DESC, id DESC);
