UPDATE users
SET
  display_name = '새유저',
  updated_at = CURRENT_TIMESTAMP
WHERE display_name <> '새유저';
