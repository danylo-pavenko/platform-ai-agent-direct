-- Adds a third state ('running') to sync_status so a KeycrmSyncRun row can be
-- created up-front as an in-flight lock — and transitions to ok/error at end.
-- Fixes the previous bug where interrupted runs (OOM / SIGKILL) stayed as
-- status='ok' with finishedAt=null forever.
ALTER TYPE "sync_status" ADD VALUE IF NOT EXISTS 'running';
