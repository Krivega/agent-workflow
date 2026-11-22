import { defineCheckAreaConfig } from '../scripts/check-area-config.mjs';
import registry from '../check-areas.profiles.json' with { type: 'json' };

const profile = registry.repository.groups.find((group) => group.id === 'core');
export default defineCheckAreaConfig({
  id: 'workflow.core',
  include: profile.files,
  coverageInclude: profile.coverageInclude,
});
