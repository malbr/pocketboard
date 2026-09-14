CREATE TYPE "public"."card_status" AS ENUM('backlog', 'doing', 'done');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"status" "card_status" DEFAULT 'backlog' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
