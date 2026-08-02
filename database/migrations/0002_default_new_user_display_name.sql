UPDATE users
SET
  display_name = '새유저',
  updated_at = CURRENT_TIMESTAMP
WHERE created_at = updated_at;
