CREATE TABLE "bug_hunt_finds" (
	"account_id" text NOT NULL,
	"day" text NOT NULL,
	"bug" text NOT NULL,
	"spot" text NOT NULL,
	"found_at" bigint NOT NULL,
	CONSTRAINT "bug_hunt_finds_account_id_day_pk" PRIMARY KEY("account_id","day")
);
--> statement-breakpoint
ALTER TABLE "bug_hunt_finds" ADD CONSTRAINT "bug_hunt_finds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bug_hunt_day_idx" ON "bug_hunt_finds" USING btree ("day","found_at");