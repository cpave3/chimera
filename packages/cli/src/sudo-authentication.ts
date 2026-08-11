import type { HostAuthenticationCapability, HostAuthenticationResult } from '@chimera/core';

export class OwnerLocalSudoAuthentication implements HostAuthenticationCapability {
  private readonly validatedRequests = new Set<string>();

  constructor(
    private readonly validate: (request: {
      requestId: string;
      command: string;
      signal?: AbortSignal;
    }) => Promise<HostAuthenticationResult>,
  ) {}

  async authenticateSudo(request: {
    requestId: string;
    command: string;
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
