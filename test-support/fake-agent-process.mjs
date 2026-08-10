import { appendFileSync } from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  if (process.argv.includes('--sleep')) {
    setTimeout(() => {}, 5000);
    return;
  }
  if (process.argv.includes('--large')) {
    process.stdout.write('x'.repeat(10_000));
    return;
  }
  if (process.env.FAKE_CAPTURE) appendFileSync(process.env.FAKE_CAPTURE, input);
  process.stdout.write('ok\n');
});
