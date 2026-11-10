CREATE TABLE "custom_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"sealed_api_key" text NOT NULL,
	"models" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "custom_endpoints_owner_name_index" ON "custom_endpoints" ("owner","name");--> statement-breakpoint
ALTER TABLE "custom_endpoints" ADD CONSTRAINT "custom_endpoints_owner_users_id_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id");