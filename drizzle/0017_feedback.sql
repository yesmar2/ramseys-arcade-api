CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"path" text,
	"account_id" text,
	"name" text,
	"user_agent" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "feedback_created_at_idx" ON "feedback" USING btree ("created_at");