import type {
  HostAuthenticationCapability,
  HostAuthenticationCheckResult,
  HostAuthenticationResult,
} from '@chimera/core';

export class OwnerLocalSudoAuthentication implements HostAuthenticationCapability {
  private readonly validatedRequests = new Set<string>();

  constructor(
    private readonly check: (request: {
      requestId: string;
      command: string;
      signal?: AbortSignal;
    }) => Promise<HostAuthenticationCheckResult>,
    private readonly validate: (request: {
      requestId: string;
      command: string;
      password: Uint8Array;
      signal?: AbortSignal;
    }) => Promise<HostAuthenticationResult>,
  ) {}

  async checkSudo(request: {
    requestId: string;
    command: string;
    signal?: AbortSignal;
  }): Promise<HostAuthenticationCheckResult> {
    const result = await this.check(request);
    if (result.status === 'validated') this.validatedRequests.add(request.requestId);
    return result;
  }

  async authenticateSudo(request: {
    requestId: string;
    command: string;
    password: Uint8Array;
    signal?: AbortSignal;
  }): Promise<HostAuthenticationResult> {
    const result = await this.validate(request);
    if (result.status === 'validated') this.validatedRequests.add(request.requestId);
    return result;
  }

  consumeSudoAuthentication(requestId: string): boolean {
    return this.validatedRequests.delete(requestId);
  }
}
