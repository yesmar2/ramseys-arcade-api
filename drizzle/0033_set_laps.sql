CREATE TABLE "set_laps" (
	"game" text NOT NULL,
	"course" integer NOT NULL,
	"ms" integer NOT NULL,
	"at" bigint NOT NULL,
	"by" text,
	CONSTRAINT "set_laps_game_course_pk" PRIMARY KEY("game","course")
);
