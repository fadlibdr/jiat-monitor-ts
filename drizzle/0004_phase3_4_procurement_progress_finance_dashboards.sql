CREATE TABLE "dash_alerts" (
	"company_id" bigint NOT NULL,
	"kind" varchar(30) NOT NULL,
	"ref" varchar(80) NOT NULL,
	"site_id" bigint NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "dash_alerts_company_id_kind_ref_pk" PRIMARY KEY("company_id","kind","ref")
);
--> statement-breakpoint
CREATE TABLE "dash_balances" (
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"receivable_0_30_cents" bigint DEFAULT 0 NOT NULL,
	"receivable_31_60_cents" bigint DEFAULT 0 NOT NULL,
	"receivable_61_90_cents" bigint DEFAULT 0 NOT NULL,
	"receivable_90p_cents" bigint DEFAULT 0 NOT NULL,
	"payable_total_cents" bigint DEFAULT 0 NOT NULL,
	"payable_overdue_cents" bigint DEFAULT 0 NOT NULL,
	"receivable_count" integer DEFAULT 0 NOT NULL,
	"pr_open" integer DEFAULT 0 NOT NULL,
	"pr_waiting" integer DEFAULT 0 NOT NULL,
	"po_outstanding_cents" bigint DEFAULT 0 NOT NULL,
	"po_overdue_count" integer DEFAULT 0 NOT NULL,
	"photos_7d" integer DEFAULT 0 NOT NULL,
	"asked_7d" integer DEFAULT 0 NOT NULL,
	"open_konfirmasi" integer DEFAULT 0 NOT NULL,
	"open_cek" integer DEFAULT 0 NOT NULL,
	"confirm_minutes_7d" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "dash_balances_company_id_site_id_pk" PRIMARY KEY("company_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "dash_contracts" (
	"contract_id" bigint PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"number" varchar(100) NOT NULL,
	"employer_name" text NOT NULL,
	"status" varchar(20) NOT NULL,
	"value_dpp_cents" bigint NOT NULL,
	"addendum_delta_cents" bigint NOT NULL,
	"value_dpp_effective_cents" bigint NOT NULL,
	"value_total_cents" bigint NOT NULL,
	"end_date_effective" date,
	"terms_total" integer NOT NULL,
	"terms_issued" integer NOT NULL,
	"terms_ready" integer NOT NULL,
	"commitment" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dash_monthly" (
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"period" date NOT NULL,
	"po_issued_cents" bigint DEFAULT 0 NOT NULL,
	"gr_received_cents" bigint DEFAULT 0 NOT NULL,
	"invoiced_dpp_cents" bigint DEFAULT 0 NOT NULL,
	"invoiced_total_cents" bigint DEFAULT 0 NOT NULL,
	"cash_in_cents" bigint DEFAULT 0 NOT NULL,
	"cash_out_cents" bigint DEFAULT 0 NOT NULL,
	"cost_by_category" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "dash_monthly_company_id_site_id_period_pk" PRIMARY KEY("company_id","site_id","period")
);
--> statement-breakpoint
CREATE TABLE "dash_progress" (
	"contract_id" bigint NOT NULL,
	"period" date NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"planned_micro_pct" bigint NOT NULL,
	"actual_micro_pct" bigint,
	"deviation_micro_pct" bigint,
	CONSTRAINT "dash_progress_contract_id_period_pk" PRIMARY KEY("contract_id","period")
);
--> statement-breakpoint
CREATE TABLE "dash_refreshes" (
	"company_id" bigint PRIMARY KEY NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dash_vendors" (
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"vendor_id" bigint NOT NULL,
	"vendor_name" text NOT NULL,
	"po_value_cents" bigint NOT NULL,
	"undelivered_cents" bigint NOT NULL,
	CONSTRAINT "dash_vendors_company_id_site_id_vendor_id_pk" PRIMARY KEY("company_id","site_id","vendor_id")
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"company_id" bigint NOT NULL,
	"doc_type" varchar(10) NOT NULL,
	"year" integer NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sequences_company_id_doc_type_year_pk" PRIMARY KEY("company_id","doc_type","year")
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"gr_id" bigint NOT NULL,
	"po_item_id" bigint NOT NULL,
	"qty_received" numeric(18, 4) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"po_id" bigint NOT NULL,
	"number" varchar(40) NOT NULL,
	"received_at" date NOT NULL,
	"received_by" bigint,
	"note" text,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"payable_type" varchar(20) NOT NULL,
	"payable_id" bigint NOT NULL,
	"paid_at" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"method" varchar(12) NOT NULL,
	"reference" varchar(100),
	"note" text,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"report_id" bigint NOT NULL,
	"boq_item_id" bigint NOT NULL,
	"qty_done" numeric(18, 4),
	"cumulative_micro_pct" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"contract_id" bigint NOT NULL,
	"period" date NOT NULL,
	"reported_by" bigint,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"po_id" bigint NOT NULL,
	"pr_item_id" bigint,
	"boq_item_id" bigint,
	"description" text NOT NULL,
	"qty" numeric(18, 4) NOT NULL,
	"unit" varchar(20),
	"unit_price_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"vendor_id" bigint NOT NULL,
	"pr_id" bigint,
	"contract_id" bigint,
	"number" varchar(40) NOT NULL,
	"order_date" date NOT NULL,
	"expected_date" date,
	"ppn_rate_bp" integer DEFAULT 1100 NOT NULL,
	"dpp_cents" bigint DEFAULT 0 NOT NULL,
	"ppn_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"note" text,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_request_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"pr_id" bigint NOT NULL,
	"boq_item_id" bigint,
	"description" text NOT NULL,
	"qty" numeric(18, 4) NOT NULL,
	"unit" varchar(20),
	"est_price_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"contract_id" bigint,
	"number" varchar(40) NOT NULL,
	"requested_by" bigint,
	"needed_by" date,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"note" text,
	"decided_by" bigint,
	"decided_at" timestamp with time zone,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_invoices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"site_id" bigint NOT NULL,
	"contract_id" bigint NOT NULL,
	"term_id" bigint NOT NULL,
	"number" varchar(40) NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"progress_micro_pct" bigint NOT NULL,
	"dpp_cents" bigint NOT NULL,
	"advance_deduction_cents" bigint NOT NULL,
	"retention_cents" bigint NOT NULL,
	"ppn_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"status" varchar(12) DEFAULT 'issued' NOT NULL,
	"created_by" bigint,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD COLUMN "po_id" bigint;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD COLUMN "gr_id" bigint;--> statement-breakpoint
ALTER TABLE "dash_alerts" ADD CONSTRAINT "dash_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_alerts" ADD CONSTRAINT "dash_alerts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_balances" ADD CONSTRAINT "dash_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_balances" ADD CONSTRAINT "dash_balances_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_contracts" ADD CONSTRAINT "dash_contracts_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_contracts" ADD CONSTRAINT "dash_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_contracts" ADD CONSTRAINT "dash_contracts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_monthly" ADD CONSTRAINT "dash_monthly_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_monthly" ADD CONSTRAINT "dash_monthly_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_progress" ADD CONSTRAINT "dash_progress_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_progress" ADD CONSTRAINT "dash_progress_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_progress" ADD CONSTRAINT "dash_progress_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_refreshes" ADD CONSTRAINT "dash_refreshes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_vendors" ADD CONSTRAINT "dash_vendors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_vendors" ADD CONSTRAINT "dash_vendors_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dash_vendors" ADD CONSTRAINT "dash_vendors_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_gr_id_goods_receipts_id_fk" FOREIGN KEY ("gr_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_po_item_id_purchase_order_items_id_fk" FOREIGN KEY ("po_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_items" ADD CONSTRAINT "progress_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_items" ADD CONSTRAINT "progress_items_report_id_progress_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."progress_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_items" ADD CONSTRAINT "progress_items_boq_item_id_boq_items_id_fk" FOREIGN KEY ("boq_item_id") REFERENCES "public"."boq_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_reports" ADD CONSTRAINT "progress_reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_reports" ADD CONSTRAINT "progress_reports_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_reports" ADD CONSTRAINT "progress_reports_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_pr_item_id_purchase_request_items_id_fk" FOREIGN KEY ("pr_item_id") REFERENCES "public"."purchase_request_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_boq_item_id_boq_items_id_fk" FOREIGN KEY ("boq_item_id") REFERENCES "public"."boq_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_pr_id_purchase_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."purchase_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_pr_id_purchase_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."purchase_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_boq_item_id_boq_items_id_fk" FOREIGN KEY ("boq_item_id") REFERENCES "public"."boq_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_term_id_contract_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."contract_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dash_contracts_company" ON "dash_contracts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "dash_progress_company" ON "dash_progress" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_items_gr" ON "goods_receipt_items" USING btree ("gr_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_items_po_item" ON "goods_receipt_items" USING btree ("po_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_company_number" ON "goods_receipts" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "goods_receipts_po" ON "goods_receipts" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "payments_payable" ON "payments" USING btree ("payable_type","payable_id");--> statement-breakpoint
CREATE INDEX "payments_company_paid" ON "payments" USING btree ("company_id","paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "progress_items_report_item" ON "progress_items" USING btree ("report_id","boq_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "progress_reports_contract_period" ON "progress_reports" USING btree ("contract_id","period");--> statement-breakpoint
CREATE INDEX "progress_reports_company_status" ON "progress_reports" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "purchase_order_items_po" ON "purchase_order_items" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "purchase_order_items_boq" ON "purchase_order_items" USING btree ("boq_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_company_number" ON "purchase_orders" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor" ON "purchase_orders" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_company_status" ON "purchase_orders" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "purchase_request_items_pr" ON "purchase_request_items" USING btree ("pr_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_requests_company_number" ON "purchase_requests" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "purchase_requests_company_status" ON "purchase_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_company_number" ON "sales_invoices" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_term_live" ON "sales_invoices" USING btree ("term_id") WHERE status <> 'cancelled';--> statement-breakpoint
CREATE INDEX "sales_invoices_contract" ON "sales_invoices" USING btree ("contract_id");--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_gr_id_goods_receipts_id_fk" FOREIGN KEY ("gr_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;