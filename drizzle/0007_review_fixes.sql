ALTER TABLE "goods_receipts" ALTER COLUMN "number" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "purchase_orders" ALTER COLUMN "number" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "purchase_requests" ALTER COLUMN "number" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "sales_invoices" ALTER COLUMN "number" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "daily_digests" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "daily_digests" ADD COLUMN "delivered_chat_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "idempotency_key" varchar(64);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" varchar(64);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "payment_terms_days" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_company_idempotency" ON "goods_receipts" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_company_idempotency" ON "payments" USING btree ("company_id","idempotency_key");