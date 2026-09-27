CREATE TABLE "track_laps" (
	"id" text PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"track" integer NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"score" integer NOT NULL,
	"device" text NOT NULL,
	"run_id" text,
	"duration_ms" bigint,
	"at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "track_laps" ADD CONSTRAINT "track_laps_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "track_laps_game_track_score_idx" ON "track_laps" USING btree ("game","track","score");--> statement-breakpoint
CREATE INDEX "track_laps_name_idx" ON "track_laps" USING btree ("name");