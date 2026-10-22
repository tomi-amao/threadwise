/**
 * The generative UI contract, frontend side.
 *
 * `ui-contract.json` is generated from the backend's Pydantic models (and checked to be
 * current by the backend's own tests). Here: every example in it parses with our Zod schemas,
 * and the schemas describe the same fields, required fields, enum values and types. A field
 * added on one side only fails this test. No browser needed; it runs in one project.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { test, expect } from './fixtures';
import {
  CATALOGUE_VERSION,
  COMPONENTS,
  INTERRUPTS,
  parseUiMessage,
} from '../app/components/assistant/catalogue';

type Json = Record<string, unknown>;

// Read rather than imported: Node's ESM loader would need an import attribute for JSON.
const contract = JSON.parse(
  readFileSync(new URL('../app/components/assistant/ui-contract.json', import.meta.url), 'utf8')
) as {
  version: number;
  components: Record<string, Json>;
  interrupts: Record<string, Json>;
  examples: Record<string, unknown[]>;
  interrupt_examples: Record<string, unknown[]>;
};

/** A comparable outline of a JSON Schema: properties, required, enums and leaf types. */
function shape(schema: Json, root: Json): unknown {
  const s = resolve(schema, root);
  const branches = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (branches) {
    const real = branches.map(b => resolve(b, root)).filter(b => b.type !== 'null');
    if (real.length === 1) return shape(real[0], root);
    // A set: Python's `float | int` is two branches that are both a number here.
    return { anyOf: [...new Set(real.map(b => JSON.stringify(shape(b, root))))].sort() };
  }
  if (s.type === 'object' || s.properties) {
    const properties = (s.properties ?? {}) as Record<string, Json>;
    if (Object.keys(properties).length === 0 && s.additionalProperties) {
      return { map: shape(s.additionalProperties as Json, root) };
    }
    return {
      properties: Object.fromEntries(
        Object.keys(properties)
          .sort()
          .map(k => [k, shape(properties[k], root)])
      ),
      required: [...((s.required as string[]) ?? [])].sort(),
    };
  }
  if (s.type === 'array') return { array: shape(s.items as Json, root) };
  if (s.const !== undefined) return { enum: [s.const] };
  if (s.enum) return { enum: [...(s.enum as unknown[])].sort() };
  // Python's int and float are both a number to JavaScript.
  return s.type === 'integer' ? 'number' : s.type;
}

function resolve(schema: Json, root: Json): Json {
  const ref = schema.$ref as string | undefined;
  if (!ref) return schema;
  const name = ref.split('/').pop() as string;
  const defs = (root.$defs ?? root.definitions ?? {}) as Record<string, Json>;
  return resolve(defs[name], root);
}

const zodShape = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return shape(json, json);
};

test.describe('assistant UI contract', () => {
  test('the catalogue versions match', () => {
    expect(contract.version).toBe(CATALOGUE_VERSION);
  });

  test('the same components and interrupts exist on both sides', () => {
    expect(Object.keys(COMPONENTS).sort()).toEqual(Object.keys(contract.components).sort());
    expect(Object.keys(INTERRUPTS).sort()).toEqual(Object.keys(contract.interrupts).sort());
  });

  for (const name of Object.keys(contract.components)) {
    test(`${name}: Zod and Pydantic describe the same props`, () => {
      const python = contract.components[name];
      expect(zodShape(COMPONENTS[name as keyof typeof COMPONENTS])).toEqual(shape(python, python));
    });
  }

  for (const kind of Object.keys(contract.interrupts)) {
    test(`${kind} (an interrupt): Zod and Pydantic describe the same payload`, () => {
      const python = contract.interrupts[kind];
      expect(zodShape(INTERRUPTS[kind as keyof typeof INTERRUPTS])).toEqual(shape(python, python));
    });
  }

  test('every example from the backend parses', () => {
    for (const [name, examples] of Object.entries(contract.examples)) {
      expect(examples.length, `${name} has examples`).toBeGreaterThan(0);
      for (const [i, props] of examples.entries()) {
        expect(parseUiMessage({ id: `${name}-${i}`, name, props }), `${name} #${i}`).not.toBeNull();
      }
    }
    for (const [kind, payloads] of Object.entries(contract.interrupt_examples)) {
      expect(payloads.length, `${kind} has examples`).toBeGreaterThan(0);
      for (const payload of payloads) {
        expect(INTERRUPTS[kind as keyof typeof INTERRUPTS].safeParse(payload).success).toBe(true);
      }
    }
  });

  test('a bad or unknown component renders nothing instead of breaking', () => {
    const table = contract.examples.table[0] as Json;
    expect(parseUiMessage({ id: 'x', name: 'pie-chart', props: {} })).toBeNull();
    expect(
      parseUiMessage({ id: 'x', name: 'table', props: { ...table, rows: 'nope' } })
    ).toBeNull();
    // A link out of the app is refused, whatever the tool said.
    const source = { ...(table.source as Json), link: 'https://evil.example' };
    expect(parseUiMessage({ id: 'x', name: 'table', props: { ...table, source } })).toBeNull();
    // A newer catalogue than this app knows is not guessed at.
    expect(
      parseUiMessage({ id: 'x', name: 'table', props: table, metadata: { catalogue: 99 } })
    ).toBeNull();
  });
});
