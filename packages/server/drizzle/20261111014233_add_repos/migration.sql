CREATE TABLE "project_repos" (
	"project_id" uuid,
	"repo_id" uuid,
	"dir" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"gh_token" boolean DEFAULT true NOT NULL,
	"last_included" boolean DEFAULT true NOT NULL,
	"last_branch" text,
	CONSTRAINT "project_repos_pkey" PRIMARY KEY("project_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "repo_shares" (
	"repo_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_shares_pkey" PRIMARY KEY("repo_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner" uuid NOT NULL,
	"remote_url" text NOT NULL,
	"added_at" text NOT NULL,
	"git_credential_id" uuid,
	"known_hosts_entry" text,
	"hosted" boolean DEFAULT false NOT NULL,
	"guard_default_branch" boolean DEFAULT true NOT NULL,
	"keeps_hosted_repo" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_repos" (
	"workspace_id" text,
	"repo_id" uuid,
	"path" text NOT NULL,
	"base_branch" text,
	"start_commit" text,
	CONSTRAINT "workspace_repos_pkey" PRIMARY KEY("workspace_id","repo_id")
);
--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "repos" jsonb;
--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "nested" boolean;
--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "cwd" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_nested" boolean;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_cwd" text;
--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "repos" jsonb DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "nested" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "cwd" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "repos" jsonb DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "nested" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "cwd" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cwd" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "repo_id" uuid;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "cwd" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Each project's remote becomes a repo with the project's id, so hosted bare
-- repositories and the hosted URLs inside existing checkouts stay valid. A
-- share has no repo of its own: it links the one it was shared from.
INSERT INTO "repos" ("id", "owner", "remote_url", "added_at", "git_credential_id", "known_hosts_entry", "hosted", "guard_default_branch", "keeps_hosted_repo")
SELECT "id", "owner", "remote_url", "added_at", "git_credential_id", "known_hosts_entry", "hosted", "guard_default_branch", "keeps_hosted_repo"
FROM "projects" WHERE "shared_from" IS NULL;
--> statement-breakpoint
INSERT INTO "project_repos" ("project_id", "repo_id", "dir", "last_branch")
SELECT p."id", coalesce(p."shared_from", p."id"),
  CASE WHEN lower(regexp_replace(p."name", '[^A-Za-z0-9._-]+', '-', 'g')) IN ('', '.', '..', '.git')
      OR regexp_replace(p."name", '[^A-Za-z0-9._-]+', '-', 'g') LIKE '-%' THEN 'repo'
    ELSE left(regexp_replace(p."name", '[^A-Za-z0-9._-]+', '-', 'g'), 100) END,
  p."last_branch"
FROM "projects" p;
--> statement-breakpoint
INSERT INTO "repo_shares" ("repo_id", "user_id")
SELECT "shared_from", "owner" FROM "projects" WHERE "shared_from" IS NOT NULL AND NOT "share_revoked"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "workspace_repos" ("workspace_id", "repo_id", "path", "base_branch", "start_commit")
SELECT w."workspace_id", coalesce(p."shared_from", p."id"), '', w."base_branch", w."start_commit"
FROM "workspaces" w JOIN "projects" p ON p."id" = w."project_id";
--> statement-breakpoint
UPDATE "queued_workspaces" q SET "repos" = jsonb_build_array(jsonb_strip_nulls(
  jsonb_build_object('repo', coalesce(p."shared_from", p."id")::text, 'branch', q."branch", 'commit', q."commit"))),
  "cwd" = coalesce(p."shared_from", p."id")::text
FROM "projects" p WHERE p."id" = q."project_id";
--> statement-breakpoint
UPDATE "routines" r SET "repos" = jsonb_build_array(jsonb_strip_nulls(
  jsonb_build_object('repo', coalesce(p."shared_from", p."id")::text, 'branch', r."branch", 'commit', r."commit"))),
  "cwd" = coalesce(p."shared_from", p."id")::text
FROM "projects" p WHERE p."id" = r."project_id";
--> statement-breakpoint
UPDATE "draft_workspaces" d SET "repos" = jsonb_build_array(
  jsonb_build_object('repo', coalesce(p."shared_from", p."id")::text, 'branch', d."branch"))
FROM "projects" p WHERE p."id" = d."project_id" AND d."branch" IS NOT NULL;
--> statement-breakpoint
UPDATE "sites" s SET "repo_id" = coalesce(p."shared_from", p."id") FROM "projects" p WHERE p."id" = s."project_id";
--> statement-breakpoint
UPDATE "sites" SET "repo_id" = "project_id" WHERE "repo_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "repo_id" SET NOT NULL;
--> statement-breakpoint
-- An approved branch names its repo.
UPDATE "workflow_approvals" a SET "ref" = coalesce(p."shared_from", p."id")::text || ':' || a."ref"
FROM "named_workflows" w JOIN "projects" p ON p."id" = w."project_id"
WHERE w."id" = a."named_workflow_id" AND a."ref" LIKE 'refs/heads/%';
--> statement-breakpoint
-- A conversation belongs to the workspace that first recorded it.
DELETE FROM "workspace_conversations" wc USING "workspace_conversations" earlier
WHERE earlier."project_id" = wc."project_id" AND earlier."tool" = wc."tool"
  AND earlier."conversation_id" = wc."conversation_id"
  AND (earlier."first_seen_at", earlier."workspace_id") < (wc."first_seen_at", wc."workspace_id");
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_git_credential_id_git_credentials_id_fkey";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_shared_from_projects_id_fkey";
--> statement-breakpoint
DROP INDEX "projects_shared_from_owner_index";
--> statement-breakpoint
ALTER TABLE "draft_workspaces" DROP COLUMN "branch";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "remote_url";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "last_branch";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "git_credential_id";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "known_hosts_entry";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "hosted";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "guard_default_branch";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "keeps_hosted_repo";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "shared_from";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "share_revoked";
--> statement-breakpoint
ALTER TABLE "queued_workspaces" DROP COLUMN "branch";
--> statement-breakpoint
ALTER TABLE "queued_workspaces" DROP COLUMN "commit";
--> statement-breakpoint
ALTER TABLE "routines" DROP COLUMN "branch";
--> statement-breakpoint
ALTER TABLE "routines" DROP COLUMN "commit";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "base_branch";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "start_commit";
--> statement-breakpoint
CREATE UNIQUE INDEX "project_repos_project_id_dir_index" ON "project_repos" ("project_id","dir");
--> statement-breakpoint
CREATE INDEX "project_repos_repo_id_index" ON "project_repos" ("repo_id");
--> statement-breakpoint
CREATE INDEX "repos_owner_index" ON "repos" ("owner");
--> statement-breakpoint
CREATE INDEX "workspace_repos_repo_id_index" ON "workspace_repos" ("repo_id");
--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id");
--> statement-breakpoint
ALTER TABLE "repo_shares" ADD CONSTRAINT "repo_shares_repo_id_repos_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "repo_shares" ADD CONSTRAINT "repo_shares_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_owner_users_id_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_git_credential_id_git_credentials_id_fkey" FOREIGN KEY ("git_credential_id") REFERENCES "git_credentials"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "workspace_repos" ADD CONSTRAINT "workspace_repos_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id") ON DELETE CASCADE;
