CREATE TABLE "source_days" (
	"day" integer NOT NULL,
	"src" text NOT NULL,
	"kind" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "source_days_day_src_kind_pk" PRIMARY KEY("day","src","kind")
);
