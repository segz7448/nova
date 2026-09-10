/**
 * automaton-cli constitution [status|clear] [--reset-baseline]
 *
 * Operator-only entry point to constitution-guard.ts's compromised
 * flag. This is deliberately not reachable from any agent tool — see
 * policy-rules/constitution-integrity.ts, which halts every tool call
 * while the flag is set and cannot clear it itself. Only a human
 * running this command from outside the agent process can.
 */

import chalk from "chalk";
import { loadConfig, resolvePath } from "automaton-vm/config.js";
import { createDatabase } from "automaton-vm/state/database.js";
import {
  checkConstitutionIntegrity,
  isConstitutionCompromised,
  compromisedDetail,
  clearCompromisedFlag,
} from "automaton-vm/soul/constitution-guard.js";

const args = process.argv.slice(3);
const subcommand = args[0] || "status";
const resetBaseline = args.includes("--reset-baseline");

function usage(): void {
  console.log(`
Usage:
  automaton-cli constitution status
      Show whether the compromised flag is set and re-run the check now.

  automaton-cli constitution clear [--reset-baseline]
      Clear the compromised flag so the agent resumes taking actions.
      Without --reset-baseline, the original genesis hash stays the
      standard the file is checked against going forward — use this
      after confirming the file is back to its original content (e.g.
      you restored it from git or from the ~/.automaton backup).

      With --reset-baseline, the CURRENT on-disk content becomes the
      new standard. Only use this if you deliberately edited
      constitution.md yourself and want that edit to be the new law —
      this is exactly the operation the agent itself can never perform.
`);
}

if (!["status", "clear"].includes(subcommand)) {
  usage();
  process.exit(1);
}

const config = loadConfig();
if (!config) {
  console.log(chalk.red("No automaton configuration found."));
  process.exit(1);
}

const dbPath = resolvePath(config.dbPath);
const db = createDatabase(dbPath);

if (subcommand === "status") {
  const flagged = isConstitutionCompromised(db);
  const live = checkConstitutionIntegrity(db);

  console.log(chalk.bold("\nConstitution integrity"));
  console.log(chalk.dim("─".repeat(52)));
  console.log(
    "Sticky flag:  " +
      (flagged ? chalk.red.bold("COMPROMISED") : chalk.green.bold("clear")),
  );
  if (flagged) {
    console.log("Recorded as:  " + chalk.yellow(compromisedDetail(db)));
  }
  console.log(
    "Live re-check: " +
      (live.ok ? chalk.green.bold("matches genesis hash") : chalk.red.bold("MISMATCH")),
  );
  console.log("  " + chalk.dim(live.detail));
  if (live.checkedPath) console.log("  path: " + chalk.white(live.checkedPath));
  console.log();

  if (flagged || !live.ok) {
    console.log(
      chalk.yellow(
        "Tool calls are being denied by the constitution.integrity_halt policy rule.\n" +
          "Investigate, then run `automaton-cli constitution clear` once resolved.",
      ),
    );
  }

  db.close();
  process.exit(flagged || !live.ok ? 1 : 0);
}

// subcommand === "clear"
const before = isConstitutionCompromised(db);
clearCompromisedFlag(db, resetBaseline);

console.log(
  before
    ? chalk.green(`Compromised flag cleared.${resetBaseline ? " Baseline hash reset to current file content." : ""}`)
    : chalk.yellow("Flag was not set — nothing to clear."),
);
if (resetBaseline) {
  console.log(
    chalk.dim(
      "Note: this makes the current on-disk constitution.md the new standard the agent is held to going forward.",
    ),
  );
}

db.close();
