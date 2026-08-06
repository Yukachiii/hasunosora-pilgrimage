CREATE TABLE `route_api_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`day_key` text NOT NULL,
	`month_key` text NOT NULL,
	`travel_mode` text NOT NULL,
	`status` text NOT NULL,
	`google_request_count` integer NOT NULL,
	`response_time_ms` integer NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `route_api_usage_day_idx` ON `route_api_usage` (`day_key`);--> statement-breakpoint
CREATE INDEX `route_api_usage_month_mode_idx` ON `route_api_usage` (`month_key`,`travel_mode`);