import { object } from '../../core/connection.js';

// Native permission profiles are authoritative; a textual read-only brief grants no isolation.
export function nativeChatPermissions(turn: Record<string, unknown>) {
  const sandbox = object(turn.sandbox_policy);
  const profile = object(turn.permission_profile);
  const managed = profile.type === 'managed';
  const filesystem = managed ? object(profile.file_system) : null;
  return {
    effective_read_only:
      sandbox.type === 'read-only' &&
      filesystem?.type === 'restricted' &&
      Array.isArray(filesystem.entries) &&
      filesystem.entries.every((entry: unknown) => object(entry).access === 'read'),
    network_access:
      sandbox.type === 'danger-full-access' ||
      sandbox.network_access === true ||
      (managed && profile.network === 'enabled')
        ? true
        : managed && profile.network === 'restricted'
          ? false
          : null,
  };
}
