// Writes of one design file's document run one after another in this process (docs/design-tool.md "Co-editing"): two people saving at once merge one after the other instead of both merging onto the same
// version and one of them losing the race. Across processes the version check of the write (and a retry) does it.

const queues = new Map<string, Promise<unknown>>();

export function serializedForFile<T>(fileId: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(fileId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(fileId, tail);
  void tail.then(() => {
    if (queues.get(fileId) === tail) queues.delete(fileId);
  });
  return run;
}
