import { defineCheckAreaConfig } from '../scripts/check-area-config.mjs';
import registry from '../check-areas.profiles.json' with { type: 'json' };

const profile = registry.repository.groups.find((group) => group.id === 'harness2');
export default defineCheckAreaConfig({
  id: 'workflow.harness2',
  include: profile.files,
  coverageInclude: profile.coverageInclude,
});
