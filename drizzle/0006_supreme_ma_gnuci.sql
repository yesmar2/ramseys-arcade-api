CREATE TABLE "name_bans" (
	"name" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"reason" text,
	"banned_by" text NOT NULL,
	"banned_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "name_bans_account_idx" ON "name_bans" USING btree ("account_id");