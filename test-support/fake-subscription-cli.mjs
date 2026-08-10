#!/usr/bin/env node

const args = process.argv.slice(2);
const help = '--search --json --ephemeral --ignore-user-config --ignore-rules --sandbox --skip-git-repo-check';

if (args.includes('--version')) {
  process.stdout.write('fake-subscription-cli 1.0\n');
  process.exit(0);
}

if (args.includes('--help')) {
  process.stdout.write(`${help}\n`);
  process.exit(0);
}

if (args.includes('login') || args.includes('auth')) {
  process.stdout.write('logged in via subscription\n');
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  void input;
  setTimeout(() => {}, 30_000);
});
