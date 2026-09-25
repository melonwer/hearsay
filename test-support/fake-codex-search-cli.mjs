#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('fake-codex-search-cli 1.0\n');
} else if (args.includes('--help')) {
  process.stdout.write('--search --json --ephemeral --ignore-user-config --ignore-rules --sandbox --skip-git-repo-check\n');
} else if (args.includes('login')) {
  process.stdout.write('logged in via subscription\n');
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    const events = [
      { type: 'thread.started', thread_id: 'acceptance-thread' },
      { type: 'item.completed', item: { type: 'web_search_call',
        action: { type: 'search', query: 'meeting notes for small teams' },
        results: [{ url: 'https://example.org/meeting-guide', title: 'Meeting guide' }] } },
      { type: 'item.completed', item: { type: 'agent_message',
        text: 'Acme is a strong choice for small sales teams. https://example.org/meeting-guide' } },
      { type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 64 } },
    ];
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
  });
}
