import { defineCheckAreaConfig } from '../scripts/check-area-config.mjs';
import registry from '../check-areas.profiles.json' with { type: 'json' };

const profile = registry.repository.groups.find((group) => group.id === 'adapters');
export default defineCheckAreaConfig({
  id: 'workflow.adapters',
  include: profile.files,
  coverageInclude: profile.coverageInclude,
});
