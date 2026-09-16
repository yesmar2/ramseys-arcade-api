CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"digest_key" text,
	"count" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"read_at" bigint
);
--> statement-breakpoint
CREATE TABLE "push_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"day_key" integer NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"last_key" text
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"time_zone" text,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"failed_at" bigint
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_ledger" ADD CONSTRAINT "push_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notif_account_idx" ON "notifications" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "notif_unread_idx" ON "notifications" USING btree ("account_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notif_digest_idx" ON "notifications" USING btree ("account_id","digest_key");--> statement-breakpoint
CREATE UNIQUE INDEX "push_ledger_day_idx" ON "push_ledger" USING btree ("account_id","day_key");--> statement-breakpoint
CREATE UNIQUE INDEX "push_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_account_idx" ON "push_subscriptions" USING btree ("account_id");