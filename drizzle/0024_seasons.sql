CREATE TABLE "season_progress" (
	"account_id" text NOT NULL,
	"season" integer NOT NULL,
	"earned" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "season_progress_account_id_season_pk" PRIMARY KEY("account_id","season")
);
--> statement-breakpoint
ALTER TABLE "season_progress" ADD CONSTRAINT "season_progress_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;