# Installed core registration source

The fixed factory preload imports the adopted installed file
`dist/src/update-ledger-core-registration.js` using the same file URL identity
as the CLI's relative import, then calls
`registerCoreHelperBootstrap(bootstrap: FixedCoreHelperBootstrap): void` once.
There is no default helper or path/module/environment/CLI activation selector.
Registration reserves before reading a foreign `start` getter and the existing
process bridge binds the original function. Duplicate or late registration is
refused. Registration is not proof of installation, authority or trust.

The real setup/check branch consumes that registration before considering
`installSetupPackage`. When absent, the ordinary installer/re-exec and setup
behavior remains. When present, the factory must already have verified the
EX-completed installed artifact and must hold both original SH leases. That
branch executes setup once, with no package installer/re-exec underneath SH.
The product owns its runtime, private run token, one serializer/parse snapshot,
frame and original stdout write callback. Completion follows that callback and
preserves the original body and 0/1/2 exit. An unavailable observer leaves an
unknown observation; it does not replace or retry setup. A failed write sends
no frame body, and an original setup exception remains an exception without a
fabricated public result. No updateLedger field is added to normal output.

The factory owns the original before receipt, bootstrap metadata, fixed preload,
bounded fd7 DTO and fd4 authority endpoint, helper launch, kernel broker and
the existing issuer/store/lease verifiers. The product does not read fd7 or
duplicate the nested parser. The adopted factory source fa41c0b names the
basename/export above and requires factory public_preload/preload_record/
bootstrap_record plus product core_registration whole-source roles.

The new product tests use synthetic ChildProcess streams and private in-process
ports only. Factory before/preload tests are separate saved dedicated fixtures.
The actual parent executor's fd7/verified installed entry spawn under both SH,
actual issuer/store/resource/all-writer coverage, actual npm artifact, exact
final whole-source pins, normal PRCI/main and Emma activation remain separate.
The setup body's config/hooks/runtime writers require their real resource and
writer coverage even though npm/re-exec is outside this branch.
This source does not activate a host or establish live trust.
