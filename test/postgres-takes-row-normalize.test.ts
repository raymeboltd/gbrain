import { describe, expect, test } from 'bun:test';
import { listStaleTakes, type PgTakesDeps } from '../src/core/postgres-engine/takes.ts';

describe('Postgres stale-take row normalization', () => {
  test('coerces bigint driver ids before the embedding writer validates them', async () => {
    const sql = async () => [{
      take_id: 2n,
      page_slug: 'projects/car',
      row_num: 7n,
      claim: 'Insurance documents are due tomorrow',
    }];
    const deps = { sql } as unknown as PgTakesDeps;

    const rows = await listStaleTakes(deps);

    expect(rows).toEqual([{
      take_id: 2,
      page_slug: 'projects/car',
      row_num: 7,
      claim: 'Insurance documents are due tomorrow',
    }]);
    expect(Number.isInteger(rows[0].take_id)).toBe(true);
    expect(() => JSON.stringify(rows)).not.toThrow();
  });
});
