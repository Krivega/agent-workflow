import { readFileSync } from 'node:fs';
import { BaseSequencer } from 'vitest/node';
import { externalToolSlots, usesExternalTools } from './vitestToolDependencies.mjs';

export default class ToolTestSequencer extends BaseSequencer {
  async sort(tests) {
    const ordered = await super.sort(tests);
    const failed = [],
      tools = [],
      ordinary = [],
      deferred = [];
    let failedTools = 0;
    for (const test of ordered) {
      const source = readFileSync(test.moduleId, 'utf8');
      const tool = usesExternalTools(test.moduleId);
      if (/^\s*\/\/ @vitest-defer\b/m.test(source)) deferred.push(test);
      else if (this.ctx.cache.getTestSpecificationResult(test)?.failed) {
        failed.push(test);
        if (tool) failedTools++;
      } else if (tool) tools.push(test);
      else ordinary.push(test);
    }
    const result = [...failed];
    const workers = this.ctx.config.maxWorkers;
    if (workers > 1) {
      // A queued tool occupies a Vitest worker even before it starts. Keep the
      // reserved worker runnable regardless of inaccurate or absent timings.
      const initial = Math.max(0, externalToolSlots(workers) - failedTools);
      return [
        ...failed,
        ...tools.slice(0, initial),
        ...ordinary,
        ...tools.slice(initial),
        ...deferred,
      ];
    }
    let ordinaryIndex = 0;
    for (const tool of tools) {
      result.push(tool);
      result.push(...ordinary.slice(ordinaryIndex, ordinaryIndex + 2));
      ordinaryIndex += 2;
    }
    return [...result, ...ordinary.slice(ordinaryIndex), ...deferred];
  }
}
