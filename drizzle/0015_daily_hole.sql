CREATE TABLE "daily_hole_results" (
	"account_id" text NOT NULL,
	"day" text NOT NULL,
	"tries" integer NOT NULL,
	"pattern" text NOT NULL,
	"name" text,
	"solved_at" bigint NOT NULL,
	CONSTRAINT "daily_hole_results_account_id_day_pk" PRIMARY KEY("account_id","day")
);
--> statement-breakpoint
ALTER TABLE "daily_hole_results" ADD CONSTRAINT "daily_hole_results_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_hole_day_idx" ON "daily_hole_results" USING btree ("day","tries","solved_at");