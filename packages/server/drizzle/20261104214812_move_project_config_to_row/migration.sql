ALTER TABLE "projects" ADD COLUMN "port_forwards" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cache_volumes" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "nested_containers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "npm_cache" boolean DEFAULT true NOT NULL;