# Owned Chrome input for window handoff (source candidate)

Contract reference: OL-RemoteWindow `codex/window-handoff-contract` commit
`661e6e02c2947c4f6ab9d2b9ee7765c43c126c9e`, `docs/window-handoff-contract.md`.
This candidate branches from GPT Connector main `77f3dd9`. It is excluded from
the 0.16.4 release and has no CLI import or default activation.

`prepareOwnedWindowHandoff` sequences the local boundary:

1. Copy hint/profile/deadline/signal once at function entry into a frozen local tuple.
   Retain the original AbortSignal reference, so abort still reaches the request even
   if the caller reuses its mutable input object. The original deadline is at most 120 seconds.
2. Pass an HWND location hint to the Host's `beginWatch`. The Host must authenticate
   the actual local principal and establish its real lifetime anchor before returning.
3. Retain the original watch object; verify it and then request a new CDP/OS capture.
4. Require one owned dedicated-profile listener, one visible non-minimized Win_1,
   one provider page, identical PID/creation/SID/positive session/HWND, and a capture
   observed after watchArmed. Reuse the existing strict Chrome command validation.
5. Bind an immutable local identity/CDP snapshot to the same watch. Verify the original
   lifetime, registration, signal and deadline again after the bind response.

Raw argv/profile are consumed locally and omitted from the binding. Neither binding nor
return value is an offer, public locator, peer reservation or viewer authorization.
No room/token/key/title is collected. Host/backend still own all real lifetime checks
at offer, claim and worker admission. Attribute equality alone cannot detect same-process
HWND reuse. A rejected anchor is never replaced by a new marker in this function.

The TypeScript ports are a normalized in-process adapter contract, not an invented
wire codec. The Windows local IPC codec must be mapped only after its fixed source
arrives. `assertCurrent` must validate the actual OS-backed original anchor. Production
ports must bound every call using the supplied absolute deadline and signal; cancellation
must settle for the exact owned watch even after admission expiry. These are pending
adapter responsibilities, not proven by the pure fixtures. Before a watch receipt exists,
a failed/uncertain begin is blocked without a new watch retry; the future IPC must account
for unknown creation outcomes. No claim of confirmed cleanup is made in that case.

After a received watch, failures attempt cancellation once. Cancellation rejection is
`HANDOFF_LOCAL_CLEANUP_UNCONFIRMED`; private port errors never become public messages.
There is no automatic retry, generation refresh, other-window fallback or replace=true.

New seven pure test groups cover normal sequencing, identity/source/staleness/ambiguity,
same-PID HWND reuse, missing/lost monitoring, late capture/bind receipts, final-generation
mutation and unconfirmed cancellation. They do not prove Windows hook/property, local
principal authentication, real CDP-HWND capture, actual HTTP, notifications, claim/peer
reservation, media/input, FOX deployment or Owner authentication. All those integrations
remain disabled and outside this candidate.

## Request-alias repair

Independent review of 4727cf1 found that only deadline had been snapshotted. Re-reading
profile/hint/signal from a mutable caller alias after await could change profile/window
admission or hide an abort of the original signal. Readonly parameter typing would not
fix an alias held by the caller.

Every admission check, profile comparison and local port now consumes the same entry
tuple. The caller object is not frozen and the original AbortSignal is not copied into
a disconnected controller. Four new tests alone show before 3 fail/1 pass to after
4 pass: replacing profile, replacing signal while aborting the original, and replacing
the hint each yield bind0/cancel1; unchanged tuple yields bind1/cancel0 and every port
receives the original signal/deadline. The previous seven groups were not re-run.
