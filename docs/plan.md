# Implementation plan

1. Establish a strict Next.js project and the signed webhook contract.
2. Persist support events and transition history in PostgreSQL. Claim work with expiring leases and implement bounded retry.
3. Add offline classification, an opt-in model provider, a Trigger.dev schedule and a local demo.
4. Build the operator dashboard and exercise intake, retry, inspection and approval end to end.

The Trigger.dev examples informed the HTTP and task boundary. FlowPulse owns its data model, queue and approval state machine.
