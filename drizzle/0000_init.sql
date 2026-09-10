CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" bigint NOT NULL,
	"plan" text NOT NULL,
	"google_sub" text,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directed_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"target_name" text NOT NULL,
	"from_account_id" text NOT NULL,
	"from_name" text,
	"to_name" text NOT NULL,
	"invite_code" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"name" text NOT NULL,
	"joined_at" bigint NOT NULL,
	CONSTRAINT "group_members_group_id_name_pk" PRIMARY KEY("group_id","name")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"invite_code" text NOT NULL,
	"created_by_account_id" text NOT NULL,
	CONSTRAINT "groups_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "leaderboard_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"name" text NOT NULL,
	"score" integer NOT NULL,
	"at" bigint NOT NULL,
	"device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"token" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "name_claims" (
	"name" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"claimed_at" bigint NOT NULL,
	"account_id" text,
	"avatar_id" text
);
--> statement-breakpoint
CREATE TABLE "record_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"record_id" text NOT NULL,
	"name" text NOT NULL,
	"score" integer NOT NULL,
	"at" bigint NOT NULL,
	"device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"official" boolean DEFAULT false NOT NULL,
	"cadence" text,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"invite_code" text
);
--> statement-breakpoint
CREATE TABLE "trophy_awards" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"period_key" integer NOT NULL,
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	"score" integer NOT NULL,
	"games" integer NOT NULL,
	"account_id" text,
	"awarded_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trophy_cursor" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"weekly_initialized" boolean DEFAULT false NOT NULL,
	"monthly_initialized" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_to_status_idx" ON "directed_invites" USING btree ("to_name","status");--> statement-breakpoint
CREATE INDEX "invites_target_idx" ON "directed_invites" USING btree ("kind","target_id","status");--> statement-breakpoint
CREATE INDEX "group_members_name_idx" ON "group_members" USING btree ("name");--> statement-breakpoint
CREATE INDEX "groups_creator_idx" ON "groups" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE INDEX "lb_game_score_at_idx" ON "leaderboard_scores" USING btree ("game","score","at");--> statement-breakpoint
CREATE INDEX "lb_game_at_idx" ON "leaderboard_scores" USING btree ("game","at");--> statement-breakpoint
CREATE INDEX "lb_name_idx" ON "leaderboard_scores" USING btree ("name");--> statement-breakpoint
CREATE INDEX "magic_links_expires_idx" ON "magic_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "name_claims_account_idx" ON "name_claims" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "rec_game_record_score_idx" ON "record_scores" USING btree ("game","record_id","score","at");--> statement-breakpoint
CREATE INDEX "rec_name_idx" ON "record_scores" USING btree ("name");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tournaments_official_cadence_idx" ON "tournaments" USING btree ("official","cadence");--> statement-breakpoint
CREATE INDEX "tournaments_starts_idx" ON "tournaments" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "tournaments_invite_idx" ON "tournaments" USING btree ("invite_code");--> statement-breakpoint
CREATE INDEX "trophy_name_idx" ON "trophy_awards" USING btree ("name");--> statement-breakpoint
CREATE INDEX "trophy_period_key_idx" ON "trophy_awards" USING btree ("period","period_key");