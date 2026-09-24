ALTER TABLE "notifications" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "resolved_at" bigint;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "pushed_at" bigint;--> statement-breakpoint
-- Alerts filed before rows remembered their push already had their one chance; don't send them again.
UPDATE "notifications" SET "pushed_at" = "created_at" WHERE "kind" IN ('match-open', 'match-closing', 'challenge-beaten');
