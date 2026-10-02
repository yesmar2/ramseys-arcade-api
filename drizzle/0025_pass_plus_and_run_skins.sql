CREATE TABLE "season_plus" (
	"account_id" text NOT NULL,
	"season" integer NOT NULL,
	"source" text NOT NULL,
	"ref" text,
	"amount" integer,
	"currency" text,
	"at" bigint NOT NULL,
	CONSTRAINT "season_plus_account_id_season_pk" PRIMARY KEY("account_id","season")
);
--> statement-breakpoint
ALTER TABLE "lap_ghosts" ADD COLUMN "skin" text;--> statement-breakpoint
ALTER TABLE "leaderboard_scores" ADD COLUMN "skin" text;--> statement-breakpoint
ALTER TABLE "track_laps" ADD COLUMN "skin" text;--> statement-breakpoint
ALTER TABLE "season_plus" ADD CONSTRAINT "season_plus_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "season_plus_ref_idx" ON "season_plus" USING btree ("ref");