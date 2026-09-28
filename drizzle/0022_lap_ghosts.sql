CREATE TABLE "lap_ghosts" (
	"game" text NOT NULL,
	"track" integer NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"time_ms" integer NOT NULL,
	"splits" jsonb NOT NULL,
	"path" jsonb NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "lap_ghosts_game_track_pk" PRIMARY KEY("game","track")
);
--> statement-breakpoint
ALTER TABLE "lap_ghosts" ADD CONSTRAINT "lap_ghosts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;