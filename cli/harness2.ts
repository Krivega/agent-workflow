import { harness2Bridge } from '../adapters/codex/harness2Bridge.js';

await harness2Bridge(process.argv[2] ?? '', new AbortController().signal);
