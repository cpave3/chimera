import { asSchema, type ToolSet } from 'ai';
import Ajv from 'ajv';

export interface ToolCall {
  name: string;
  args: unknown;
}

export type ToolMiddleware = (
  call: ToolCall,
  next: (call?: ToolCall) => Promise<unknown>,
) => Promise<unknown>;

/** What a tool call produced: the value handed to the model, or the error. */
export type ToolOutcome = { result: unknown } | { error: Error };

export interface ToolCallInterceptor {
  /** Return an outcome to answer the call without running the tool. */
  before?(call: ToolCall): Promise<ToolOutcome | undefined> | ToolOutcome | undefined;
  /** Return the outcome the model should see; return `outcome` to leave it alone. */
  after?(call: ToolCall, outcome: ToolOutcome): Promise<ToolOutcome> | ToolOutcome;
}

type ExecutableTool = {
  execute?: (args: unknown, options: unknown) => Promise<unknown>;
};

const schemaValidator = new Ajv({ strict: false });

/**
 * Wrap every tool's execute, including MCP and subagents. Middleware runs
 * outside hooks so its rewritten input is what validation and permissions see.
 */
export function interceptTools(
  tools: ToolSet,
  interceptors: ToolCallInterceptor[],
  middleware?: ToolMiddleware,
): ToolSet {
  if (interceptors.length === 0 && !middleware) return tools;
  const wrapped: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const original = (definition as ExecutableTool).execute;
    if (!original) {
      wrapped[name] = definition;
      continue;
    }
    wrapped[name] = {
      ...definition,
      execute: async (args: unknown, options: unknown) => {
        const initial: ToolCall = { name, args };
        const execute = async (call = initial) => {
          if (call.name !== name) throw new Error('Tool middleware cannot change the tool name');
          if (middleware && definition.inputSchema) {
            const schema = asSchema(definition.inputSchema);
            if (schema.validate) {
              const validated = await schema.validate(call.args);
              if (!validated.success) throw validated.error;
              call = { ...call, args: validated.value };
            } else {
              const validate = schemaValidator.compile(await schema.jsonSchema);
              if (!validate(call.args)) {
                throw new Error(
                  `Invalid arguments for ${name}: ${schemaValidator.errorsText(validate.errors)}`,
                );
              }
            }
          }
          let outcome: ToolOutcome | undefined;
          for (const interceptor of interceptors) {
            outcome = await interceptor.before?.(call);
            if (outcome) break;
          }
          if (!outcome) {
            try {
              outcome = { result: await original.call(definition, call.args, options) };
            } catch (error) {
              outcome = { error: error instanceof Error ? error : new Error(String(error)) };
            }
          }
          for (const interceptor of interceptors) {
            if (interceptor.after) outcome = await interceptor.after(call, outcome);
          }
          if ('error' in outcome) throw outcome.error;
          return outcome.result;
        };
        return middleware ? middleware(initial, execute) : execute();
      },
    } as ToolSet[string];
  }
  return wrapped;
}
