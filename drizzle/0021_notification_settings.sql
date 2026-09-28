CREATE TABLE "notification_settings" (
	"account_id" text PRIMARY KEY NOT NULL,
	"levels" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;