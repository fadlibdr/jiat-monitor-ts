CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint,
	"user_id" bigint,
	"action" varchar(30) NOT NULL,
	"auditable_type" varchar(60),
	"auditable_id" bigint,
	"before" jsonb,
	"after" jsonb,
	"meta" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_addendums" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"contract_id" bigint NOT NULL,
	"number" varchar(100) NOT NULL,
	"signed_at" date NOT NULL,
	"value_delta_cents" bigint DEFAULT 0 NOT NULL,
	"end_date_new" date,
	"note" text,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_terms" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"contract_id" bigint NOT NULL,
	"seq" smallint NOT NULL,
	"name" text NOT NULL,
	"percent_bp" integer NOT NULL,
	"trigger_progress_bp" integer NOT NULL,
	"due_days" integer DEFAULT 30 NOT NULL,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "bank_account" varchar(40);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "retention_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "advance_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "created_by" bigint;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "updated_by" bigint;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "created_by" bigint;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "updated_by" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" varchar(30);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "telegram_user_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_system_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_addendums" ADD CONSTRAINT "contract_addendums_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_addendums" ADD CONSTRAINT "contract_addendums_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_auditable" ON "audit_logs" USING btree ("auditable_type","auditable_id");--> statement-breakpoint
CREATE INDEX "audit_logs_user_created" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_addendums_contract_number" ON "contract_addendums" USING btree ("contract_id","number");--> statement-breakpoint
CREATE INDEX "contract_addendums_contract" ON "contract_addendums" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_terms_contract_seq" ON "contract_terms" USING btree ("contract_id","seq");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id");