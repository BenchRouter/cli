import { mock } from 'node:test';

// Advance the deadline clock without replacing HTTP requests or polling timers.
mock.timers.enable({ apis: ['Date'], now: Date.now() });
setInterval(() => mock.timers.tick(60000), 250).unref();
