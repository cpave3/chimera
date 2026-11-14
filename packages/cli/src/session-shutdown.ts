export type ShutdownReason = 'exit' | 'signal';

export async function shutdownLifecycle(
  registry: { shutdown(reason: ShutdownReason, timeoutMs: number): Promise<void> },
  mods: { shutdown(): Promise<void> },
  reason: ShutdownReason,
): Promise<void> {
  await registry.shutdown(reason, 2000);
  await mods.shutdown();
}

export function onShutdownSignals(shutdown: (reason: ShutdownReason) => Promise<void>): () => void {
  const finish = (reason: ShutdownReason) => {
    void shutdown(reason).catch((error) => {
      process.stderr.write(
        `shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
  };
  const onInterrupt = () => finish('exit');
  const onSignal = () => finish('signal');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  return () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
  };
}
