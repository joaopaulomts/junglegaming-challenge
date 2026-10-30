import { type MoneyProps } from "../../domain/shared/money";
import type { EventContext, IntegrationEventEnvelope } from "../../domain/outbox/integration-event";
import type { AnyIntegrationEvent } from "../../domain/outbox/events";

export type EventEnvelope = IntegrationEventEnvelope<Record<string, unknown>>;

export function serializeEvent(event: AnyIntegrationEvent): EventEnvelope {
	return event.toJSON() as unknown as EventEnvelope;
}

export type InboundEventEnvelope = EventEnvelope;
