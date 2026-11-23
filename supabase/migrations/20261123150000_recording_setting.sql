-- Admin switch: keep a copy of voicemail / call-recording audio in the dashboard (default on).
alter table app_settings add column if not exists save_recordings boolean not null default true;
