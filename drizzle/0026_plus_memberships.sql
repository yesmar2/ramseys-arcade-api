CREATE TABLE "memberships" (
	"account_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"customer" text,
	"subscription" text,
	"status" text NOT NULL,
	"renews_at" bigint,
	"cancels_at_end" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;