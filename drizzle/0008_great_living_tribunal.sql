CREATE TABLE "challenge_results" (
	"challenge_id" text NOT NULL,
	"name" text NOT NULL,
	"account_id" text,
	"score" integer NOT NULL,
	"won" boolean NOT NULL,
	"reply_id" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "challenge_results_challenge_id_name_pk" PRIMARY KEY("challenge_id","name")
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"name" text NOT NULL,
	"account_id" text NOT NULL,
	"score" integer NOT NULL,
	"score_id" text NOT NULL,
	"reply_to" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "challenge_results" ADD CONSTRAINT "challenge_results_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_results" ADD CONSTRAINT "challenge_results_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "challenges_account_idx" ON "challenges" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "challenges_score_idx" ON "challenges" USING btree ("score_id");