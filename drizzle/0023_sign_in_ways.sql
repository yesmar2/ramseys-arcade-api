CREATE TABLE "email_codes" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "discord_id" text;--> statement-breakpoint
CREATE INDEX "email_codes_expires_idx" ON "email_codes" USING btree ("expires_at");