CREATE TABLE "background_sessions" (
	"project_slug" text,
	"session_id" text,
	CONSTRAINT "background_sessions_pkey" PRIMARY KEY("project_slug","session_id")
);
