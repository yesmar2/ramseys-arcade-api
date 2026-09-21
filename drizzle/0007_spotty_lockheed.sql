CREATE TABLE "run_claims" (
	"run_id" text NOT NULL,
	"surface" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"claimed_at" bigint NOT NULL,
	CONSTRAINT "run_claims_run_id_surface_ref_pk" PRIMARY KEY("run_id","surface","ref")
);
--> statement-breakpoint
CREATE TABLE "score_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"score_id" text NOT NULL,
	"game" text NOT NULL,
	"name" text NOT NULL,
	"score" integer NOT NULL,
	"kind" text NOT NULL,
	"detail" text NOT NULL,
	"run_id" text,
	"duration_ms" bigint,
	"created_at" bigint NOT NULL,
	"reviewed_at" bigint
);
--> statement-breakpoint
CREATE INDEX "run_claims_run_idx" ON "run_claims" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "score_flags_unreviewed_idx" ON "score_flags" USING btree ("reviewed_at","created_at");--> statement-breakpoint
CREATE INDEX "score_flags_name_idx" ON "score_flags" USING btree ("name");--> statement-breakpoint
ALTER TABLE "game_runs" DROP COLUMN "used_at";