import { runCommand } from './cli.ts';

const code = await runCommand(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
if (code !== null) process.exitCode = code;
