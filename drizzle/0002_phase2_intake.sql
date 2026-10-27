CREATE TABLE "attachments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint,
	"attachable_type" varchar(40) NOT NULL,
	"attachable_id" bigint NOT NULL,
	"path" text NOT NULL,
	"mime" varchar(100) NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"phash" varchar(16),
	"telegram_file_id" text,
	"telegram_message_id" bigint,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"from_user_id" bigint,
	"kind" varchar(12) NOT NULL,
	"payload" jsonb NOT NULL,
	"outcome" varchar(30) DEFAULT 'pending' NOT NULL,
	"vendor_invoice_id" bigint,
	"reply_message_id" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" varchar(50) NOT NULL,
	"company_id" bigint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"done_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"title" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_chats_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
CREATE TABLE "vendor_invoices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"row_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" bigint,
	"vendor_name" text,
	"npwp" varchar(16),
	"invoice_date" date,
	"doc_number" varchar(100),
	"description" text,
	"category" varchar(20),
	"dpp_cents" bigint,
	"ppn_cents" bigint,
	"total_cents" bigint NOT NULL,
	"due_date" date,
	"status" varchar(20) NOT NULL,
	"source" varchar(10) NOT NULL,
	"image_hash" varchar(64),
	"phash" varchar(16),
	"confidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" bigint,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_invoices_row_id_unique" UNIQUE("row_id")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"name" text NOT NULL,
	"npwp" varchar(16),
	"bank_name" text,
	"bank_account" varchar(40),
	"phone" varchar(30),
	"default_category" varchar(20),
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_company_sha256" ON "attachments" USING btree ("company_id","sha256");--> statement-breakpoint
CREATE INDEX "attachments_attachable" ON "attachments" USING btree ("attachable_type","attachable_id");--> statement-breakpoint
CREATE INDEX "attachments_site_created" ON "attachments" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_events_chat_message" ON "intake_events" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "intake_events_chat_reply" ON "intake_events" USING btree ("chat_id","reply_message_id");--> statement-breakpoint
CREATE INDEX "intake_events_company_created" ON "intake_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("run_at") WHERE done_at IS NULL AND failed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_invoices_company_image" ON "vendor_invoices" USING btree ("company_id","image_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_invoices_confirmed_unique" ON "vendor_invoices" USING btree ("company_id","vendor_id","invoice_date","total_cents") WHERE status = 'terkonfirmasi';--> statement-breakpoint
CREATE INDEX "vendor_invoices_company_status" ON "vendor_invoices" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "vendor_invoices_site" ON "vendor_invoices" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_company_name" ON "vendors" USING btree ("company_id","name");