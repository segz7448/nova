#!/usr/bin/env node
/**
 * Automaton CLI
 *
 * Creator-facing CLI for interacting with an automaton.
 * Usage: automaton-cli <command> [args]
 */

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "status":
      await import("./commands/status.js");
      break;
    case "logs":
      await import("./commands/logs.js");
      break;
    case "fund":
      await import("./commands/fund.js");
      break;
    case "send":
      await import("./commands/send.js");
      break;
    case "constitution":
      await import("./commands/constitution.js");
      break;
    default:
      console.log(`
Automaton CLI - Creator Tools

Usage:
  automaton-cli status              Show automaton status
  automaton-cli logs [--tail N]     View automaton logs
  automaton-cli fund <amount> [--to 0x...]  Transfer USDC
  automaton-cli send <to-address> <message> Send a social message
  automaton-cli constitution status         Check constitution integrity
  automaton-cli constitution clear [--reset-baseline]
                                             Clear a tripped integrity halt
`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
