CREATE TABLE "friend_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"from_account_id" text NOT NULL,
	"from_name" text,
	"to_account_id" text NOT NULL,
	"to_name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id_a" text NOT NULL,
	"account_id_b" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "friend_requests_to_status_idx" ON "friend_requests" USING btree ("to_account_id","status");--> statement-breakpoint
CREATE INDEX "friend_requests_from_status_idx" ON "friend_requests" USING btree ("from_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "friendships_pair_idx" ON "friendships" USING btree ("account_id_a","account_id_b");--> statement-breakpoint
CREATE INDEX "friendships_a_idx" ON "friendships" USING btree ("account_id_a");--> statement-breakpoint
CREATE INDEX "friendships_b_idx" ON "friendships" USING btree ("account_id_b");