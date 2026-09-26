CREATE TABLE "client_errors" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"path" text,
	"release" text,
	"user_agent" text,
	"count" integer NOT NULL,
	"first_at" bigint NOT NULL,
	"last_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "client_errors_last_at_idx" ON "client_errors" USING btree ("last_at");