import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from 'ai';

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
};

// Names models reach for when they forget what this session calls a tool.
const TOOL_NAME_ALIASES: Record<string, string[]> = {
  shell: ['bash'],
  run: ['bash'],
  execute: ['bash'],
  read_file: ['read'],
  view: ['read'],
  cat: ['read'],
  write_file: ['write'],
  create_file: ['write'],
  edit_file: ['edit', 'apply_patch'],
  str_replace: ['edit'],
  search: ['grep'],
  list_files: ['glob', 'find'],
  glob: ['find'],
  find: ['glob'],
  ls: ['read'],
  edit: ['apply_patch'],
};

/**
 * Fix the mechanical mistakes in a tool call that would otherwise cost the
 * model a step: a tool name in the wrong case or under a familiar alias, and
 * arguments that are right in substance but wrong in encoding. Returns null
 * when nothing can be fixed; the SDK then reports the original error to the
 * model. A repaired call is validated again, so a wrong guess is harmless.
 */
export const repairToolCall: ToolCallRepairFunction<ToolSet> = async ({
  toolCall,
  tools,
  inputSchema,
  error,
}) => {
  if (NoSuchToolError.isInstance(error)) {
    const toolName = resolveToolName(toolCall.toolName, Object.keys(tools));
    return toolName ? { ...toolCall, toolName } : null;
  }

  const parsed = parseArguments(toolCall.input);
  if (parsed === undefined) return null;
  const schema = (await inputSchema({ toolName: toolCall.toolName })) as JsonSchema;
  const input = JSON.stringify(coerce(parsed, schema));
  return input === toolCall.input ? null : { ...toolCall, input };
};

function resolveToolName(called: string, registered: string[]): string | undefined {
  const wanted = called.toLowerCase().replace(/^(functions|tools?)[.:/]/, '');
  const byLowerCase = new Map(registered.map((name) => [name.toLowerCase(), name]));
  const direct = byLowerCase.get(wanted) ?? byLowerCase.get(wanted.replace(/[-\s]/g, '_'));
  if (direct) return direct;
  return TOOL_NAME_ALIASES[wanted]?.find((candidate) => registered.includes(candidate));
}

/** Read the arguments as an object, through a code fence or a second layer of JSON encoding. */
function parseArguments(raw: string): Record<string, unknown> | undefined {
  let text = raw.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value !== 'string') return undefined;
    text = value;
  }
  return undefined;
}

function schemaTypes(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  const own = schema.type === undefined ? [] : [schema.type].flat();
  return [...own, ...(schema.anyOf ?? []).flatMap(schemaTypes)];
}

/** Convert values to the type their schema demands, where the intent is unambiguous. */
function coerce(args: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const types = schemaTypes(properties[key]);
    if (value === null && !required.has(key) && !types.includes('null')) continue;
    result[key] = coerceValue(value, types);
  }
  return result;
}

function coerceValue(value: unknown, types: string[]): unknown {
  if (typeof value !== 'string' || types.includes('string')) return value;
  const text = value.trim();
  if (types.includes('boolean') && (text === 'true' || text === 'false')) return text === 'true';
  if ((types.includes('number') || types.includes('integer')) && text !== '') {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  if (types.includes('array') || types.includes('object')) {
    try {
      const decoded: unknown = JSON.parse(text);
      if (decoded && typeof decoded === 'object') return decoded;
    } catch {
      // Not JSON; leave the value for validation to reject.
    }
  }
  return value;
}
