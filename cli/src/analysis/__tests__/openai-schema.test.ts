import { describe, it, expect } from 'vitest';
import { toStrictOpenAiSchema } from '../openai-schema.js';

describe('toStrictOpenAiSchema', () => {
  it('enforces required to contain all keys from properties and makes optional keys nullable', () => {
    const input = {
      type: 'object',
      properties: {
        req1: { type: 'string' },
        opt1: { type: 'string' },
        opt2: { type: 'number' },
      },
      required: ['req1'],
    };

    const output = toStrictOpenAiSchema(input);

    expect(output.additionalProperties).toBe(false);
    expect(output.required).toEqual(['req1', 'opt1', 'opt2']);
    expect(output.properties.req1.type).toBe('string');
    expect(output.properties.opt1.type).toEqual(['string', 'null']);
    expect(output.properties.opt2.type).toEqual(['number', 'null']);
  });

  it('handles nested objects recursively', () => {
    const input = {
      type: 'object',
      properties: {
        step_matrix: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              targets: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['step'],
          },
        },
      },
      // step_matrix omitted from root required
    };

    const output = toStrictOpenAiSchema(input);

    expect(output.required).toEqual(['step_matrix']);
    expect(output.properties.step_matrix.type).toEqual(['array', 'null']);

    const itemSchema = output.properties.step_matrix.items;
    expect(itemSchema.additionalProperties).toBe(false);
    expect(itemSchema.required).toEqual(['step', 'targets']);
    expect(itemSchema.properties.step.type).toBe('string');
    expect(itemSchema.properties.targets.type).toEqual(['array', 'null']);
  });

  it('preserves already nullable types and does not duplicate null', () => {
    const input = {
      type: 'object',
      properties: {
        nullableOpt: { type: ['string', 'null'] },
      },
    };

    const output = toStrictOpenAiSchema(input);

    expect(output.required).toEqual(['nullableOpt']);
    expect(output.properties.nullableOpt.type).toEqual(['string', 'null']);
  });

  it('handles anyOf property when making nullable', () => {
    const input = {
      type: 'object',
      properties: {
        unionProp: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
    };

    const output = toStrictOpenAiSchema(input);

    expect(output.required).toEqual(['unionProp']);
    expect(output.properties.unionProp.anyOf).toEqual([
      { type: 'string' },
      { type: 'number' },
      { type: 'null' },
    ]);
  });
});
