CREATE TABLE "course_bests" (
	"account_id" text NOT NULL,
	"game" text NOT NULL,
	"course" integer NOT NULL,
	"ms" integer NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "course_bests_account_id_game_course_pk" PRIMARY KEY("account_id","game","course")
);
--> statement-breakpoint
ALTER TABLE "course_bests" ADD CONSTRAINT "course_bests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;