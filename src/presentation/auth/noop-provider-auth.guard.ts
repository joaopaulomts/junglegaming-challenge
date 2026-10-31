import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

/**
 * No-op guard by explicit decision: authentication is out of scope for this
 * challenge (see ARCHITECTURE.md). Identity arrives via `x-provider-id` header,
 * which the domain still validates against the payload (provider identity is a
 * domain fact, not a transport assumption).
 *
 * Extension point: replace this provider binding with an OIDC guard (Keycloak /
 * Zitadel) without touching controllers.
 */
@Injectable()
export class NoopProviderAuthGuard implements CanActivate {
	constructor() {}

	canActivate(context: ExecutionContext): boolean {
		void context;
		return true;
	}
}
