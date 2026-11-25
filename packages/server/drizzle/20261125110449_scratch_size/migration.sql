ALTER TABLE "projects" ALTER COLUMN "scratch_dirs" SET DEFAULT '{"dirs":[{"path":"node_modules"},{"path":"target"}],"sizeGiB":32,"ignoredTracked":[]}';--> statement-breakpoint
UPDATE "projects" SET "scratch_dirs" = jsonb_build_object(
  'dirs', COALESCE((SELECT jsonb_agg(jsonb_build_object('path', d->>'path')) FROM jsonb_array_elements("scratch_dirs"->'dirs') AS d), '[]'::jsonb),
  'sizeGiB', LEAST(1024, COALESCE(NULLIF((SELECT sum(COALESCE((d->>'sizeGiB')::int, 16)) FROM jsonb_array_elements("scratch_dirs"->'dirs') AS d), 0)
    * GREATEST((SELECT count(*) FROM "project_repos" AS r WHERE r."project_id" = "projects"."id"), 1), 32)),
  'ignoredTracked', COALESCE("scratch_dirs"->'ignoredTracked', '[]'::jsonb)
);
