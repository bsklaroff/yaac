ALTER TABLE "projects" ADD COLUMN "shared_from" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "share_revoked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_shared_from_owner_index" ON "projects" ("shared_from","owner");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_shared_from_projects_id_fkey" FOREIGN KEY ("shared_from") REFERENCES "projects"("id");