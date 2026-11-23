ALTER TABLE "repos" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "upstream_repo_id" uuid;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "push_access" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "guard_allows_catch_up" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_upstream_repo_id_repos_id_fkey" FOREIGN KEY ("upstream_repo_id") REFERENCES "repos"("id");