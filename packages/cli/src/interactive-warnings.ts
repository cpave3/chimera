type WarningSink = (message: string) => void;

/** Buffer startup warnings until the terminal owner is ready, or startup fails. */
export class InteractiveWarnings {
  private readonly pending: string[] = [];
  private sink?: WarningSink;

  constructor(
    private readonly stderr: WarningSink = (message) => process.stderr.write(`${message}\n`),
  ) {}

  report(message: string): void {
    if (this.sink) this.sink(message);
    else this.pending.push(message);
  }

  connect(sink: WarningSink): void {
    this.sink = sink;
    for (const message of this.pending.splice(0)) sink(message);
  }

  disconnect(): void {
    this.connect(this.stderr);
  }
}
