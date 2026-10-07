CREATE TABLE "tool_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner" uuid NOT NULL,
	"tool" text NOT NULL,
	"sealed_credential" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_credentials_owner_tool_index" ON "tool_credentials" ("owner","tool");--> statement-breakpoint
ALTER TABLE "tool_credentials" ADD CONSTRAINT "tool_credentials_owner_users_id_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id");