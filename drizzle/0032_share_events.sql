CREATE TABLE "share_events" (
	"id" text PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"kind" text NOT NULL,
	"game" text,
	"how" text NOT NULL,
	"account_id" text
);
--> statement-breakpoint
ALTER TABLE "share_events" ADD CONSTRAINT "share_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_events_at_idx" ON "share_events" USING btree ("at");