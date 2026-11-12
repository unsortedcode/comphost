// Stacks CompHost is changing right now (deploy, restart, update…). Their
// containers are expected to come and go mid-operation, so the drift watch
// leaves them alone until the operation — and its own re-attach — is done.
const busy = new Set();

export const markBusy = (stackId) => busy.add(stackId);
export const clearBusy = (stackId) => busy.delete(stackId);
export const isBusy = (stackId) => busy.has(stackId);
