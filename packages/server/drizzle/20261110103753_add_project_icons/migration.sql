CREATE TABLE "project_icons" (
	"project_id" uuid PRIMARY KEY,
	"mime_type" text NOT NULL,
	"bytes" bytea NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_icons" ADD CONSTRAINT "project_icons_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;