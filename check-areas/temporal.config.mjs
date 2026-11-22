import { defineCheckAreaConfig } from '../scripts/check-area-config.mjs';
import registry from '../check-areas.profiles.json' with { type: 'json' };

const profile = registry.repository.groups.find((group) => group.id === 'temporal');
export default defineCheckAreaConfig({
  id: 'workflow.temporal',
  include: profile.files,
  coverageInclude: profile.coverageInclude,
});
