# ChatGPT runtime bridge contract

This is the canonical function and data-flow contract for ChatGPT bridge discovery.
It covers `connector.ts` → `page-bridge.ts` and the bootstrap failure connection.
Grok has a separate bridge. Public CLI/MCP schemas remain in `contract.ts`.

## Overall function diagram and connections

| Owner | Function | Public connection / output |
| --- | --- | --- |
| CLI / MCP / browser preparation | Open a `ChatGptConnector` | Connector diagnostics and model/chat/upload/close operations |
| `connector.ts` | Reuse a bridge with matching version/build ID, or discover the runtime and bootstrap | `runtime-discovery.ts`, `createBridgeBootstrapExpression(runtimeUrl)`, CDP `evaluateByValue` |
| `page-bridge.ts` | Generate a single-flight bootstrap expression; identify runtime exports; build the application scope | A page-local bridge, version 1, content-derived `bridgeBuildId`, validated summary |
| `page-bridge.ts` bridge methods | Use the selected scope, sender, uploader and Request API | `createBridgeCallExpression(method, args)`; page-owned sessions/operations/upload/download maps |
| `runtime-evaluate.ts` / `runtime-failure.ts` | Convert bootstrap exceptions into structured connector errors | `RUNTIME_DRIFT`, stage `bridge_bootstrap`, allowlisted tag; no raw source/count in diagnostics |
| Runtime error assessment / reporting | Preserve genuine drift classification | Existing high/register=true policy; this repair changes no reporting schema or historical event |

## Discovery function diagram

1. Reuse the matching bridge; otherwise import the discovered runtime URL and require a usable `__webpack_require__` cache/module table.
2. Flatten cached module exports. Identify each role by its existing source or shape contract. Deduplicate aliases by function/object identity and require one candidate per role.
3. Select the root AppScope token. Inaccessible cross-origin exports do not identify a scope.
4. Select the scope wrapper using `getOwnValue`, `queryClient` and `/watch=[\w$]+/` source markers. Exclude functions containing `useContext` (the React hook). Function arity is not part of this contract: both six-argument wrappers and three-argument wrappers with optional options are supported.
5. Build the existing 17-field scope node using the selected atom/store/scheduler/query client. Invoke `scopeWrapper(scopeToken, chain, node)`; optional arguments are omitted.
6. Probe the existing Request candidates with `/models`, create bridge-owned maps, install the bridge and return its summary. The caller validates version/build ID and summary.

## Data-flow diagram and ownership

| From | Data / boundary | To and ownership |
| --- | --- | --- |
| Runtime discovery | Official ChatGPT runtime URL | Connector passes URL as a JSON literal into the generated bootstrap |
| ChatGPT runtime cache | Export values and function source | Page-local discovery reads only; source is not sent to the host/reporting |
| Unique role discovery | Scope token, wrapper, atom/store constructors, scheduler, QueryClient | Page-local node and scope; upstream runtime remains externally owned |
| Generated bootstrap | SHA-256-derived build ID | Connector reuse/summary validation and factory diagnostics |
| Selected scope | Scope object | Sender and uploader; existing Request API handles models/conversations |
| Connector operation | JSON-encoded method arguments | Bridge-owned operation/session/buffer maps; existing operation result schemas |
| Missing/ambiguous role | `RUNTIME_DRIFT:<role>:<count>` | CDP exception → `evaluateByValue` → safe stage/tag → existing error assessment/report |

## Failure and recovery transitions

`uninitialized → discovering → unique roles → scope built → ready`.
Missing or ambiguous roles transition to `bootstrap failed` before installing the bridge,
protecting against invoking the wrong runtime function. The single-flight pending promise
is cleared on success or rejection. A later caller automatically retries discovery from
`uninitialized`; a changed runtime or corrected connector can reach `ready` without a lock reset.
Build changes invalidate reuse of an older installed bridge. Authentication/network handling
remains in the existing connector/browser-preparation contracts.

## Change scope and verification

The scope-wrapper predicate is the only runtime behavior changed for 0.16.15.
`test/page-bridge.test.ts` executes discovery with old/new wrapper fixtures, the React hook,
alias exports, missing candidates and ambiguous wrappers. The existing connector diagnostics
and continuation tests cover the build-ID caller connections. Release version references
and the changelog ship with this document and implementation.
