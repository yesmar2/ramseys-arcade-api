CREATE TABLE "game_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"game" text NOT NULL,
	"started_at" bigint NOT NULL,
	"used_at" bigint
);
--> statement-breakpoint
ALTER TABLE "leaderboard_scores" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "leaderboard_scores" ADD COLUMN "duration_ms" bigint;--> statement-breakpoint
ALTER TABLE "leaderboard_scores" ADD COLUMN "ip_hash" text;--> statement-breakpoint
ALTER TABLE "leaderboard_scores" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "game_runs" ADD CONSTRAINT "game_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_runs_account_idx" ON "game_runs" USING btree ("account_id","started_at");--> statement-breakpoint
CREATE INDEX "game_runs_started_idx" ON "game_runs" USING btree ("started_at");