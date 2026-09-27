CREATE TABLE "hole_results" (
	"account_id" text NOT NULL,
	"game" text NOT NULL,
	"day" text NOT NULL,
	"name" text NOT NULL,
	"tries" integer NOT NULL,
	"pattern" text NOT NULL,
	"device" text NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "hole_results_account_id_game_day_pk" PRIMARY KEY("account_id","game","day")
);
--> statement-breakpoint
ALTER TABLE "hole_results" ADD CONSTRAINT "hole_results_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hole_results_game_day_idx" ON "hole_results" USING btree ("game","day","tries","at");