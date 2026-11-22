import { nativeChatPermissions } from '../adapters/codex/nativeChatPermissions.js';

function context() {
  return {
    sandbox_policy: { type: 'read-only' } as Record<string, unknown>,
    permission_profile: {
      type: 'managed',
      file_system: { type: 'restricted', entries: [{ access: 'read' }] },
      network: 'restricted',
    } as Record<string, unknown>,
  };
}

it('reads the actual managed read-only format when sandbox network_access is omitted', () => {
  expect(nativeChatPermissions(context())).toEqual({
    effective_read_only: true,
    network_access: false,
  });
});

it.each([
  { type: 'disabled' },
  { type: 'managed', file_system: { type: 'unrestricted' }, network: 'restricted' },
  { type: 'managed', file_system: { type: 'restricted', entries: null }, network: 'restricted' },
  {
    type: 'managed',
    file_system: { type: 'restricted', entries: [{ access: 'write' }] },
    network: 'restricted',
  },
  {
    type: 'managed',
    file_system: { type: 'restricted', entries: [{ access: 'unknown' }] },
    network: 'restricted',
  },
])('never treats a broad or unknown permission profile as read-only: %j', (profile) => {
  expect(
    nativeChatPermissions({ ...context(), permission_profile: profile }).effective_read_only,
  ).toBe(false);
});

it('rejects network access or unknown network policy even beside a read-only filesystem', () => {
  const turn = context();
  turn.permission_profile.network = 'enabled';
  expect(nativeChatPermissions(turn).network_access).toBe(true);
  turn.permission_profile.network = 'unknown';
  expect(nativeChatPermissions(turn).network_access).toBeNull();
  turn.permission_profile.network = 'restricted';
  turn.sandbox_policy.network_access = true;
  expect(nativeChatPermissions(turn).network_access).toBe(true);
  turn.sandbox_policy.type = 'danger-full-access';
  expect(nativeChatPermissions(turn)).toEqual({ effective_read_only: false, network_access: true });
});
