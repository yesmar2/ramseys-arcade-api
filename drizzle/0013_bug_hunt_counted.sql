ALTER TABLE "bug_hunt_finds" ADD COLUMN "counted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Finds kept before this all came in on the hunt's first day, Sept 24, told on that day; the ones naming its bug count.
UPDATE "bug_hunt_finds" SET "counted" = true WHERE "day" = '2026-09-24' AND "bug" = 'buzz';
