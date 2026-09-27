CREATE TABLE "prizes_owned" (
	"account_id" text NOT NULL,
	"prize_id" text NOT NULL,
	"price" integer NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "prizes_owned_account_id_prize_id_pk" PRIMARY KEY("account_id","prize_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"ref" text NOT NULL,
	"game" text,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_wallets" (
	"account_id" text PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"earned" integer DEFAULT 0 NOT NULL,
	"run_day" integer DEFAULT 0 NOT NULL,
	"run_today" integer DEFAULT 0 NOT NULL,
	"goal" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prizes_owned" ADD CONSTRAINT "prizes_owned_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_ledger" ADD CONSTRAINT "ticket_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_wallets" ADD CONSTRAINT "ticket_wallets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_ledger_account_reason_ref_idx" ON "ticket_ledger" USING btree ("account_id","reason","ref");--> statement-breakpoint
CREATE INDEX "ticket_ledger_account_at_idx" ON "ticket_ledger" USING btree ("account_id","at");