CREATE TABLE "token_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"ceiling" text NOT NULL,
	"token_hash" text UNIQUE,
	"expires_at" timestamp with time zone,
	"issuer" text,
	"subject" text,
	"claims" jsonb,
	"audience" text UNIQUE,
	"refused_subject" text,
	"refused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "created_via" text;--> statement-breakpoint
CREATE UNIQUE INDEX "token_bindings_owner_label_index" ON "token_bindings" ("owner","label");--> statement-breakpoint
ALTER TABLE "token_bindings" ADD CONSTRAINT "token_bindings_owner_users_id_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id") ON DELETE CASCADE;