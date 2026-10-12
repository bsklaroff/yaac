ALTER TABLE "projects" ADD COLUMN "hosted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "guard_default_branch" boolean DEFAULT true NOT NULL;