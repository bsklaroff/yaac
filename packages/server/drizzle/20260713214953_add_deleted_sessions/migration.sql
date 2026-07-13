CREATE TABLE "deleted_sessions" (
	"project_slug" text,
	"session_id" text,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_sessions_pkey" PRIMARY KEY("project_slug","session_id")
);
