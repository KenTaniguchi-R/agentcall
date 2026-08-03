-- Analytics Engine acknowledges writes locally and may sample or lose them
-- after the invocation. This row counts only failures the Worker can observe
-- while calling the binding; it is health evidence, not an audit ledger.
CREATE TABLE telemetry_health (
  sink TEXT PRIMARY KEY CHECK (sink IN ('agentcall_status_reads')),
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
  first_failure_at INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL CHECK (last_failure_at >= first_failure_at)
);
