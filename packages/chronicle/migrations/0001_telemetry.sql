CREATE TABLE `otel_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wake_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`at_ms` integer NOT NULL,
	`name` text NOT NULL,
	`severity` text,
	`body` text,
	`attributes` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `otel_events_wake_at_idx` ON `otel_events` (`wake_id`,`at_ms`);--> statement-breakpoint
CREATE INDEX `otel_events_at_idx` ON `otel_events` (`at_ms`);--> statement-breakpoint
CREATE TABLE `otel_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wake_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`at_ms` integer NOT NULL,
	`name` text NOT NULL,
	`value` real NOT NULL,
	`attributes` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `otel_metrics_wake_at_idx` ON `otel_metrics` (`wake_id`,`at_ms`);--> statement-breakpoint
CREATE INDEX `otel_metrics_at_idx` ON `otel_metrics` (`at_ms`);--> statement-breakpoint
CREATE TABLE `otel_spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wake_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`name` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`status` text NOT NULL,
	`attributes` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `otel_spans_wake_start_idx` ON `otel_spans` (`wake_id`,`start_ms`);--> statement-breakpoint
CREATE INDEX `otel_spans_start_idx` ON `otel_spans` (`start_ms`);--> statement-breakpoint
CREATE TABLE `wake_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wake_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`harness` text NOT NULL,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`turns` integer,
	`duration_ms` integer,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wake_usage_wake_id_unique` ON `wake_usage` (`wake_id`);--> statement-breakpoint
CREATE INDEX `wake_usage_agent_at_idx` ON `wake_usage` (`agent_id`,`recorded_at`);