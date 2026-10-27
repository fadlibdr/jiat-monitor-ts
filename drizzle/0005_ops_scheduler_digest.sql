CREATE TABLE "daily_digests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"digest_date" date NOT NULL,
	"alert_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dedupe_key" varchar(120);--> statement-breakpoint
ALTER TABLE "daily_digests" ADD CONSTRAINT "daily_digests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_digests_company_date" ON "daily_digests" USING btree ("company_id","digest_date");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key");