CREATE TABLE "tournament_players" (
	"tournament_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"joined_at" bigint NOT NULL,
	"account_id" text,
	"seq" bigserial NOT NULL,
	CONSTRAINT "tournament_players_tournament_id_id_pk" PRIMARY KEY("tournament_id","id")
);
--> statement-breakpoint
CREATE TABLE "tournament_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"tournament_id" text NOT NULL,
	"player_id" text NOT NULL,
	"game" text NOT NULL,
	"score" integer NOT NULL,
	"at" bigint NOT NULL,
	"attempt" integer,
	"match_id" text,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_scores" ADD CONSTRAINT "tournament_scores_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tournament_players_seq_idx" ON "tournament_players" USING btree ("tournament_id","seq");--> statement-breakpoint
CREATE INDEX "tournament_scores_event_idx" ON "tournament_scores" USING btree ("tournament_id","seq");