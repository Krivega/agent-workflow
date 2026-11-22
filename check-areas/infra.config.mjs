import { defineCheckAreaConfig } from '../scripts/check-area-config.mjs';
import registry from '../check-areas.profiles.json' with { type: 'json' };

const profile = registry.repository.groups.find((group) => group.id === 'infra');
export default defineCheckAreaConfig({
  id: 'workflow.infra',
  include: profile.files,
  coverageInclude: profile.coverageInclude,
});
