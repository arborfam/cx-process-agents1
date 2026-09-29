export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 409,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
