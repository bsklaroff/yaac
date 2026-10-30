ALTER TABLE "agent_sessions" RENAME TO "conversations";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "agent_session_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "agent_sessions_pkey" TO "conversations_pkey";--> statement-breakpoint
ALTER TABLE "workspace_agent_sessions" RENAME TO "workspace_conversations";--> statement-breakpoint
ALTER TABLE "workspace_conversations" RENAME COLUMN "agent_session_id" TO "conversation_id";--> statement-breakpoint
ALTER TABLE "workspace_conversations" RENAME CONSTRAINT "workspace_agent_sessions_pkey" TO "workspace_conversations_pkey";
