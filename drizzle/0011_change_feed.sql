CREATE TABLE "change_feed" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"instance" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"until" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "change_feed_at_idx" ON "change_feed" USING btree ("at");