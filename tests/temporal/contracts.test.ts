import { describe, expect, it } from 'vitest';
import {
  identifier,
  object,
  parseProject,
  relativePath,
  text,
  workflowKey,
} from '../../src/contracts/project.js';
import { checkRegistration, parsePreparation } from '../../src/policy/preparation.js';

export const project = {
  schemaVersion: 1 as const,
  projectId: 'neutral',
  workspaceId: 'main',
  rules: ['RULES.md'],
  cardRoot: 'tasks',
  roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
  checks: ['syntax'],
};
export const input = {
  schemaVersion: 1 as const,
  taskId: 'one',
  project,
  hostId: 'mac',
  owner: 'user',
  generation: 1,
  revision: 1,
  card: 'tasks/one.md',
};

describe('Temporal project contracts', () => {
  it('keeps project-specific paths and commands outside the common rules', () => {
    expect(parseProject(project)).toEqual(project);
    expect(parsePreparation(input)).toEqual(input);
    expect(workflowKey('a.b', 'c')).not.toBe(workflowKey('a', 'b.c'));
    expect(() => checkRegistration(input, { ...input, project })).not.toThrow();
    expect(object({})).toEqual({});
  });
  it.each([null, [], 1, 'x'])('rejects a nonobject %j', (value) => {
    expect(() => object(value)).toThrow('object-required');
  });
  it.each([null, '', 'x'.repeat(513)])('rejects invalid text', (value) => {
    expect(() => text(value)).toThrow('text-required');
  });
  it.each(['a/b', 'a b', '_a', 'x'.repeat(129)])('rejects ambiguous identifiers %s', (value) => {
    expect(() => identifier(value)).toThrow('invalid-identifier');
  });
  it.each(['/a', 'a//b', './a', '../a', 'a/../b', 'a\\b', 'C:/a', 'a\u0000'])(
    'rejects unsafe paths %j',
    (value) => {
      expect(() => relativePath(value)).toThrow('invalid-relative-path');
    },
  );
  it.each([
    { ...project, schemaVersion: 2 },
    { ...project, shell: 'run' },
    { projectId: 'a' },
    { ...project, roles: [{ id: 'a', profile: 'b', shell: 'run' }] },
    {
      ...project,
      roles: [
        { id: 'a', profile: 'b' },
        { id: 'a', profile: 'c' },
      ],
    },
    { ...project, rules: null },
    { ...project, rules: [] },
    { ...project, checks: ['syntax', 'syntax'] },
  ])('rejects unsupported or ambiguous project contracts', (value) => {
    expect(() => parseProject(value)).toThrow();
  });
  it('does not impose an arbitrary file or role count limit', () => {
    const rules = Array.from({ length: 129 }, (_, index) => `rules/${index}.md`);
    const roles = Array.from({ length: 129 }, (_, index) => ({
      id: `role-${index}`,
      profile: `profiles/${index}.md`,
    }));
    expect(parseProject({ ...project, rules, roles })).toEqual({ ...project, rules, roles });
  });
  it.each([
    { ...input, schemaVersion: 2 },
    { ...input, generation: 0 },
    { ...input, generation: 1.1 },
    { ...input, revision: 0 },
    { ...input, revision: 1.1 },
    { ...input, card: 'tasks-other/one.md' },
    { ...input, card: 'tasks' },
  ])('rejects invalid preparation', (value) => {
    expect(() => parsePreparation(value)).toThrow();
  });
  it.each([
    { ...input, project: { ...project, workspaceId: 'other' } },
    { ...input, hostId: 'other' },
    { ...input, owner: 'other' },
    { ...input, generation: 2 },
  ])('rejects the wrong local grant', (registration) => {
    expect(() => checkRegistration(input, registration)).toThrow();
  });
});
