/**
 * Extension point for caller identity.
 *
 * Authentication is explicitly out of scope (see ARCHITECTURE.md): no IdP is
 * deployed, so this port ships with a no-op implementation that trusts the
 * payload. The seam is real, though — replacing the implementation with one
 * that validates a JWT (Keycloak/Zitadel OIDC) changes nothing in the use
 * cases or controllers.
 */

/** DI token: the port is an interface, so the container needs a runtime key. */
export const PROVIDER_IDENTITY_TOKEN = Symbol("ProviderIdentityPort");

export interface ProviderIdentityInput {
	/** Identity asserted by the transport credential (e.g. `x-provider-id`). */
	transportProviderId: string | undefined;
	/** Identity claimed in the request body. */
	claimedProviderId: string;
}

export interface ProviderIdentity {
	providerId: string;
}

export interface ProviderIdentityPort {
	/**
	 * Resolves the provider the request must be processed as.
	 *
	 * Implementations MUST reject a request whose transport identity contradicts
	 * its claimed identity instead of silently preferring one of them.
	 */
	authenticate(input: ProviderIdentityInput): ProviderIdentity;
}

/** No IdP: an absent transport identity passes, a contradicting one does not. */
export class NoopProviderIdentityPort implements ProviderIdentityPort {
	authenticate(input: ProviderIdentityInput): ProviderIdentity {
		const transport = input.transportProviderId;
		if (transport !== undefined && transport.length > 0 && transport !== input.claimedProviderId) {
			throw new ProviderIdentityMismatchError(transport, input.claimedProviderId);
		}
		return { providerId: input.claimedProviderId };
	}
}

export class ProviderIdentityMismatchError extends Error {
	constructor(
		public readonly transportProviderId: string,
		public readonly claimedProviderId: string,
	) {
		super(`transport provider "${transportProviderId}" does not match claimed provider "${claimedProviderId}"`);
		this.name = "ProviderIdentityMismatchError";
	}
}
