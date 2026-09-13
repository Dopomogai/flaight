// @purpose: Wave-0/1 compatibility shim — the model seat now lives in @ae/model
// @why: Wave 1 Lane A of the engine extraction moved this file's logic to packages/model/src/provider.ts.
//       This shim keeps every existing `../model` / `@/lib/agents/model` import working byte-for-byte
//       during the lane moves; it is deleted in Wave 2 integration when consumers import @ae/model directly.
// @role: logic
// @stability: experimental

export * from '@ae/model/provider';
