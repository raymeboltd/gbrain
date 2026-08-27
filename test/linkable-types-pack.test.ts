import { describe, expect, test } from 'bun:test';
import {
  linkableTypesFromPack,
  parseSchemaPackManifest,
} from '../src/core/schema-pack/index.ts';

function manifest(pageTypes: Array<Record<string, unknown>>) {
  return parseSchemaPackManifest({
    api_version: 'gbrain-schema-pack-v1',
    name: 'linkable-test',
    version: '1.0.0',
    extends: null,
    page_types: pageTypes,
    link_types: [],
  });
}

describe('linkableTypesFromPack', () => {
  test('a user-defined type opts in without a core-code patch', () => {
    const pack = manifest([
      {
        name: 'researcher', primitive: 'concept', path_prefixes: ['researchers/'],
        aliases: [], extractable: false, expert_routing: false, linkable: true,
      },
    ]);
    expect(linkableTypesFromPack(pack)).toEqual(['researcher']);
  });

  test('explicit false excludes even a legacy entity name', () => {
    const pack = manifest([
      {
        name: 'person', primitive: 'entity', path_prefixes: ['people/'],
        aliases: [], extractable: false, expert_routing: true, linkable: false,
      },
    ]);
    expect(linkableTypesFromPack(pack)).toEqual([]);
  });

  test('legacy manifests preserve the narrow pre-field type list', () => {
    const pack = manifest([
      {
        name: 'person', primitive: 'entity', path_prefixes: ['people/'],
        aliases: [], extractable: false, expert_routing: true,
      },
      {
        name: 'adversary-profile', primitive: 'entity', path_prefixes: ['adversaries/'],
        aliases: [], extractable: false, expert_routing: false,
      },
    ]);
    expect(linkableTypesFromPack(pack)).toEqual(['person']);
  });
});
