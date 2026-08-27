CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`gatekeeper` text NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `events` (`at`);--> statement-breakpoint
CREATE INDEX `events_gatekeeper_at_idx` ON `events` (`gatekeeper`,`at`);--> statement-breakpoint
CREATE INDEX `events_agent_at_idx` ON `events` (`agent_id`,`at`);--> statement-breakpoint
CREATE INDEX `events_kind_at_idx` ON `events` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text NOT NULL,
	`sender` text,
	`recipient` text,
	`subject` text,
	`body` text NOT NULL,
	`ref_id` text,
	`meta` text
);
--> statement-breakpoint
CREATE INDEX `messages_agent_at_idx` ON `messages` (`agent_id`,`at`);--> statement-breakpoint
CREATE INDEX `messages_kind_at_idx` ON `messages` (`kind`,`at`);--> statement-breakpoint
CREATE INDEX `messages_at_idx` ON `messages` (`at`);--> statement-breakpoint
CREATE TABLE `wake_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wake_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`text` text NOT NULL,
	`done` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wake_log_wake_seq_idx` ON `wake_log` (`wake_id`,`seq`);--> statement-breakpoint
CREATE INDEX `wake_log_agent_at_idx` ON `wake_log` (`agent_id`,`at`);