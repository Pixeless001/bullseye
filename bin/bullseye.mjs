#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { response, validate } from "../src/gate.mjs";

const [command] = process.argv.slice(2);

if (command === "validate") {
  const errors = validate();
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Bullseye package is valid.\n");
  }
} else if (command === "hook") {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(`${JSON.stringify(response(input))}\n`);
  } catch (error) {
    process.stderr.write(`Bullseye hook error: ${error.message}\n`);
    process.exitCode = 1;
  }
} else if (command === "benchmark") {
  await import("../benchmark/run.mjs");
} else {
  process.stderr.write("Usage: bullseye <validate|hook|benchmark>\n");
  process.exitCode = 1;
}
