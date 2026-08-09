# Major workspace cutovers

Assay handles compatible upgrades, including minor releases that stay inside a
supported compatibility envelope, through its native update path. A change that
crosses a schema, layout, or authority boundary is a major cutover instead.
Version numbers alone do not select a cutover adapter; the observed control
plane and the adapter's full compatibility envelope do.

## Stop when Assay reports the boundary

Assay fails closed at an unsupported boundary before it performs normal
semantic reads or writes. A cutover error uses `Workspace cutover required` or
the registry-specific `Systems registry cutover required` and includes a stable
locator in this form:

```text
assay-cutover:<observed>-><required>
```

Preserve that locator and stop normal Assay mutation. Do not edit manifests or
authority files to make the error disappear. `assay workspace list` can report
`cutover_required`, but it only reports indexed workspace state; it does not
repair or rewrite a workspace.

Use the external [`assay-cutover`](https://github.com/X-T-E-R/assay-cutover)
package and CLI for this boundary. It is not an Assay subcommand or a built-in
Assay dependency. Its adapters are explicit and finite, so a close version
number does not imply automatic support.

## Follow the cutover journey

Stop editors, agents, hooks, and every other workspace writer before planning
or applying a cutover. Keep them stopped through validation. Retain the external
run directory: it holds the plan, backups, receipts, and restore state needed to
recover safely.

1. **Inspect.** Use the external tool to inspect the explicit workspace root. Use
   the emitted locator as handoff context, not as a substitute for inspection.
   The adapter checks the actual schema, layout, authority shape, and filesystem
   safety conditions.

2. **Plan.** Create the tool's external plan and review the selected adapter,
   target, operations, preservation set, and any manual placement guidance. Do
   not apply a plan whose report is manual, mixed, unsupported, or otherwise
   refused by the tool.

3. **Apply.** Apply only the reviewed plan for the same root and external run
   directory. The external runner pins the adapter and contract, verifies source
   state, creates verified backups, and refuses stale or unsafe plans rather
   than guessing.

4. **Validate.** Let the adapter validate the target, then run the target Assay
   CLI against the same root and require `assay check` to succeed. Review
   warnings and preserved manual material before accepting the cutover or
   restarting writers.

5. **Restore when needed.** If apply is interrupted, validation fails, or the
   result is not accepted, keep writers stopped and use the external tool's
   restore flow with the same root and run directory. Preserve the run directory
   until the restored preimages and preserved source bytes have been checked.

## Keep semantic decisions manual

Automatic application is limited to complete compatibility envelopes supported
by an adapter. Recognized-manual and unsupported cases receive a report and
placement guidance; they do not become automatic because their versions look
nearby.

The tool does not automatically turn Trellis records into native Assay Tasks or
reinterpret retired, plugin, runtime, host, or authority state as current Assay
meaning. Preserve that material and make its placement and authority decisions
explicitly.

The external repository owns the exact adapter matrix and operating procedure.
Read its [README](https://github.com/X-T-E-R/assay-cutover#readme) and
[runner contract](https://github.com/X-T-E-R/assay-cutover/blob/main/contract.json)
before a cutover; this Assay page only defines when and how to hand work across
the product boundary.
