CREATE TABLE "day_ghosts" (
	"game" text NOT NULL,
	"track" integer NOT NULL,
	"name" text NOT NULL,
	"account_id" text NOT NULL,
	"time_ms" integer NOT NULL,
	"splits" jsonb NOT NULL,
	"path" jsonb NOT NULL,
	"skin" text,
	"at" bigint NOT NULL,
	CONSTRAINT "day_ghosts_game_track_name_pk" PRIMARY KEY("game","track","name")
);
--> statement-breakpoint
ALTER TABLE "day_ghosts" ADD CONSTRAINT "day_ghosts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;