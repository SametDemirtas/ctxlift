// yields so pending signal handlers run: every step is a synchronous child process
export const yieldToEvents = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
