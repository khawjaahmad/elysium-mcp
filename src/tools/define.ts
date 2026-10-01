import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { toToolError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ChainClient, ChainGuard } from '../rpc.js';

export interface ToolContext {
  client: ChainClient;
  config: Config;
  guard: Pick<ChainGuard, 'ensure'>;
  logger: Logger;
}

export interface ToolDefinition<I extends z.ZodRawShape, O extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  handler: (args: z.infer<z.ZodObject<I>>, ctx: ToolContext) => Promise<z.infer<z.ZodObject<O>>>;
}

// Each tool has its own input/output shapes, so the registry is heterogeneous.
export type AnyToolDefinition = ToolDefinition<any, any>;

export function defineTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return def;
}

/**
 * Runs a tool handler and converts the outcome into an MCP result. Errors
 * become `isError: true` results whose text is a JSON object
 * `{ error: { code, message, retryable, hint?, details? } }`.
 */
export async function runTool(def: AnyToolDefinition, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  const started = Date.now();
  try {
    await ctx.guard.ensure();
    const result = (await def.handler(args as Record<string, unknown>, ctx)) as Record<string, unknown>;
    ctx.logger.debug(`${def.name} ok in ${Date.now() - started} ms`);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (err) {
    const toolError = toToolError(err);
    const level = toolError.code === 'INTERNAL_ERROR' ? 'error' : 'info';
    ctx.logger[level](`${def.name} failed in ${Date.now() - started} ms: ${toolError.code} ${toolError.message}`);
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: toolError.toJSON() }, null, 2) }],
    };
  }
}

export function registerTools(server: McpServer, tools: readonly AnyToolDefinition[], ctx: ToolContext): void {
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      (args: unknown) => runTool(def, args, ctx),
    );
  }
}
