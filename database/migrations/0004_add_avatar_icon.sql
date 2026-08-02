ALTER TABLE users
ADD COLUMN avatar_icon TEXT NOT NULL DEFAULT 'initial'
CHECK (avatar_icon IN ('initial', 'hidden', 'leaf', 'pine', 'water', 'stone'));
