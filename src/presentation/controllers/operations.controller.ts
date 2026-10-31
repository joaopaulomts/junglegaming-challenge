import { Controller, Get, HttpCode, HttpStatus, Inject } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { metrics } from "../../infrastructure/observability/metrics";

@Controller()
export class OperationsController {
	constructor(
		@Inject(MikroORM) private readonly orm: MikroORM,
		@Inject(SQSClient) private readonly sqs: SQSClient,
	) {}

	@Get("health/live")
	@HttpCode(HttpStatus.OK)
	liveness(): { status: "alive" } {
		return { status: "alive" };
	}

	@Get("health/ready")
	async readiness(): Promise<{ status: "ready" | "degraded"; checks: Record<string, "up" | "down"> }> {
		const checks = {
			postgresql: await this.checkPostgresql(),
			sqs: await this.checkSqs(),
		};
		const allUp = Object.values(checks).every((value) => value === "up");
		return { status: allUp ? "ready" : "degraded", checks };
	}

	@Get("metrics")
	async metricsEndpoint(): Promise<string> {
		return await metrics().registry.metrics();
	}

	private async checkPostgresql(): Promise<"up" | "down"> {
		try {
			await this.orm.em.fork().execute("SELECT 1", [], "all");
			return "up";
		} catch {
			return "down";
		}
	}

	private async checkSqs(): Promise<"up" | "down"> {
		try {
			await this.sqs.send(
				new GetQueueAttributesCommand({
					QueueUrl: process.env.SQS_REQUEST_QUEUE_URL ?? "",
					AttributeNames: ["QueueArn"],
				}),
			);
			return "up";
		} catch {
			return "down";
		}
	}
}
