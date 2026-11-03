CREATE TABLE "deleted_volumes" (
	"id" uuid PRIMARY KEY,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"holder_workspace_id" text UNIQUE,
	"attached_at" timestamp with time zone,
	"pinned_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "volume_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "volumes_project_id_name_index" ON "volumes" ("project_id","name");