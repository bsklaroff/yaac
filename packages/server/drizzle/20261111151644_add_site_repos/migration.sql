ALTER TABLE "sites" ADD COLUMN "repos" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "follow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "release_commits" jsonb;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "deploy_commits" jsonb;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "last_deploy_commits" jsonb;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "failed_commits" jsonb;--> statement-breakpoint
-- A site names its repos, each at a branch: the one it followed. One that
-- followed nothing deployed its repo's default branch, which only the main
-- clone knows, so its repo is left with no branch for the backfill at server
-- start to name (docs/legacy-compat-shims.md).
UPDATE "sites" SET
  "repos" = CASE WHEN "follow_branch" IS NULL
    THEN jsonb_build_array(jsonb_build_object('repo', "repo_id"))
    ELSE jsonb_build_array(jsonb_build_object('repo', "repo_id", 'branch', "follow_branch")) END,
  "follow" = "follow_branch" IS NOT NULL,
  "release_commits" = CASE WHEN "release_commit" IS NULL THEN NULL ELSE jsonb_build_object("repo_id"::text, "release_commit") END,
  "deploy_commits" = CASE WHEN "deploy_commit" IS NULL THEN NULL ELSE jsonb_build_object("repo_id"::text, "deploy_commit") END,
  "last_deploy_commits" = CASE WHEN "last_deploy_commit" IS NULL THEN NULL ELSE jsonb_build_object("repo_id"::text, "last_deploy_commit") END,
  "failed_commits" = CASE WHEN "failed_commit" IS NULL THEN NULL ELSE jsonb_build_object("repo_id"::text, "failed_commit") END;--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "repo_id";--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "follow_branch";--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "release_commit";--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "deploy_commit";--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "last_deploy_commit";--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "failed_commit";