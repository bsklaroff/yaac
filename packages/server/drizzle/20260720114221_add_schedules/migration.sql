CREATE TABLE "schedules" (
	"id" text PRIMARY KEY,
	"project_slug" text NOT NULL,
	"spec" text NOT NULL,
	"prompt" text NOT NULL,
	"tool" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fired_at" timestamp with time zone
);
