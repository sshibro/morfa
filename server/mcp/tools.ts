// The MCP server's reading tools (docs/mcp-server.md §Tools), each answering for the signed-in account through the files API's own
// access rule; the editing ones are edit-tools.ts, and tool-list.ts says which are offered. The shape follows Figma's own MCP server (a file's structure, a frame's layers and code, its variables) on Morfa's
// writers. Descriptions are for the model, in English. Schemas are zod 4 (`zod/v4`, which the SDK reads as JSON Schema); each call
// is parsed again here, so a bad argument is a tool error the model can act on, not a protocol error.
import {z} from 'zod/v4';
import {mcpIssuer} from './config';
import {
  capFiles,
  codeFor,
  CODE_FORMATS,
  fileLink,
  fileOutline,
  layerOf,
  layerTree,
  MAX_TREE_DEPTH,
  pageOf,
  targetOf,
  variablesAndStyles,
} from './design-read';
import {ToolError} from './errors';
import {listFiles, openFile} from './files';
import type {Principal} from './auth';

/** A tool's answer: the typed result, a summary for the model and, for a picture, the image itself. */
export type ToolSuccess = {structured: Record<string, unknown>; text: string; images?: {data: string; mimeType: string}[]};
/** The protocol's hints about a tool (all four are set: its defaults, destructive and open-world, are wrong for most). */
export type ToolAnnotations = {readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean};
export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  /** READ_ONLY when absent. */
  annotations?: ToolAnnotations;
  /** How long a call may take (endpoint.ts TOOL_BUDGET_MS when absent); `signal` aborts when it is over. */
  budgetMs?: number;
  /** More of the tool's `_meta` (e.g. ChatGPT's `openai/fileParams`). */
  meta?: Record<string, unknown>;
  handler: (input: any, principal: Principal, call: {signal: AbortSignal}) => Promise<ToolSuccess>;
};

/** A tool that reads and changes nothing. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const linkField = z
  .string()
  .max(2048)
  .optional()
  .describe(
    'A Morfa link to a file or a layer, as the editor copies it: https://app.morfa.example/#design/<file id>?node=<layer id>.',
  );
export const fileIdField = z
  .string()
  .max(64)
  .optional()
  .describe('The file id, from morfa_list_files. Not needed with a link.');
export const nodeIdField = z
  .string()
  .max(256)
  .optional()
  .describe('A layer id (a frame, component or any layer), from morfa_get_file or morfa_get_layers.');

/** The JSON text of a result, compact, for clients that read only text. */
const json = (value: unknown) => JSON.stringify(value);

const listFilesTool: ToolDefinition = {
  name: 'morfa_list_files',
  title: 'List Morfa files',
  description:
    "Lists the design files and boards the signed-in Morfa account can open (its own, its teams', and files shared with it), newest first. Each has an id, a name, its team, the account's role in it and a link that opens it in Morfa. Use the id with the other tools.",
  inputSchema: z
    .object({
      query: z.string().max(120).optional().describe('Part of a file name to filter by.'),
      limit: z.number().int().min(1).max(100).default(30).describe('How many files to return.'),
    })
    .strict(),
  async handler(input: {query?: string; limit: number}, principal) {
    const {files, total} = await listFiles(principal, input);
    const origin = mcpIssuer();
    const shown = files.map(file => ({...file, link: fileLink(origin, file.id)}));
    const text = total
      ? `${total} file${total === 1 ? '' : 's'}${shown.length < total ? `, showing ${shown.length}` : ''}.`
      : input.query
        ? 'No file matches that name.'
        : 'This account has no files yet.';
    return {structured: {files: shown, total}, text};
  },
};

const getFileTool: ToolDefinition = {
  name: 'morfa_get_file',
  title: "Get a Morfa file's structure",
  description:
    "Returns a Morfa file's pages in order and each page's top-level layers (frames, sections, components) with their ids, types, sizes and how many layers they hold; and how many components, styles and variables the file has. Start here, then ask for one frame's layers or code.",
  inputSchema: z
    .object({link: linkField, fileId: fileIdField, pageId: z.string().max(256).optional().describe('Only this page.')})
    .strict(),
  async handler(input: {link?: string; fileId?: string; pageId?: string}, principal) {
    const {fileId} = targetOf(input);
    const file = await openFile(principal, fileId);
    const outline = fileOutline(file.doc, input.pageId);
    const layers = outline.pages.reduce((sum, page) => sum + page.layers.length, 0);
    return {
      structured: {
        file: {
          id: file.id,
          name: file.name,
          kind: file.kind,
          team: file.team,
          version: file.version,
          link: fileLink(mcpIssuer(), file.id),
        },
        ...outline,
      },
      text: `“${file.name}”: ${outline.pages.length} page${outline.pages.length === 1 ? '' : 's'}, ${layers} top-level layer${layers === 1 ? '' : 's'} shown.`,
    };
  },
};

const getLayersTool: ToolDefinition = {
  name: 'morfa_get_layers',
  title: 'Get a layer tree',
  description:
    "Returns one layer and the layers inside it, top of the layers panel first: id, name, type, position and size, text, the component an instance comes from and its properties, the styles it uses, and its CSS as Morfa's dev mode writes it (layout, size, fills, borders, effects, typography). Use it to understand a frame before building it.",
  inputSchema: z
    .object({
      link: linkField,
      fileId: fileIdField,
      nodeId: nodeIdField,
      depth: z
        .number()
        .int()
        .min(0)
        .max(MAX_TREE_DEPTH)
        .default(4)
        .describe('How many levels below the layer to include (0: the layer alone).'),
      css: z.boolean().default(true).describe("Include each layer's CSS."),
    })
    .strict(),
  async handler(input: {link?: string; fileId?: string; nodeId?: string; depth: number; css: boolean}, principal) {
    const target = targetOf(input);
    if (!target.nodeId)
      throw new ToolError(
        'invalid_input',
        'A layer is needed.',
        'Pass nodeId (from morfa_get_file) or a link to the layer.',
      );
    const file = await openFile(principal, target.fileId);
    const {tree, shown, truncated} = layerTree(file.doc, target.nodeId, {depth: input.depth, css: input.css});
    const page = pageOf(file.doc, target.nodeId);
    return {
      structured: {
        file: {id: file.id, name: file.name},
        page: page ? {id: page, name: file.doc.nodes[page]?.name ?? ''} : null,
        layer: tree,
        layersShown: shown,
        truncated,
        link: fileLink(mcpIssuer(), file.id, target.nodeId),
      },
      text: `“${tree.name}” (${tree.type}, ${tree.width}×${tree.height}): ${shown} layer${shown === 1 ? '' : 's'} shown${truncated ? '; the tree was cut, ask for a smaller frame or less depth for the rest' : ''}.`,
    };
  },
};

const getCodeTool: ToolDefinition = {
  name: 'morfa_get_code',
  title: 'Get code for a layer',
  description:
    'Writes code for a frame or component with the same writers as Morfa\'s "Code" tab. Formats: "react" (React + TypeScript with CSS Modules; component properties become props, variants a union prop, repeated siblings a mapped array), "react-tailwind" (React with Tailwind CSS 4 classes), "react-inline" (React with inline styles), "css" (the layer\'s CSS), "svg" (the layer as SVG) and "tokens" (the file\'s styles and variables as CSS variables and a Tailwind theme; no layer needed). Picture paths point where the files would sit in a project; the pictures are not included.',
  inputSchema: z
    .object({
      link: linkField,
      fileId: fileIdField,
      nodeId: nodeIdField,
      format: z.enum(CODE_FORMATS).default('react').describe('The language of the code.'),
    })
    .strict(),
  async handler(
    input: {link?: string; fileId?: string; nodeId?: string; format: (typeof CODE_FORMATS)[number]},
    principal,
  ) {
    const target = targetOf(input);
    const file = await openFile(principal, target.fileId);
    if (target.nodeId) layerOf(file.doc, target.nodeId);
    const {files, warnings, assets} = codeFor(file.doc, target.nodeId, input.format, await measurer());
    const capped = capFiles(files);
    const body = capped.files.map(file => `// ${file.path}\n${file.contents}`).join('\n');
    const notes = [
      ...(capped.omitted.length
        ? [`Left out to keep the answer small: ${capped.omitted.join(', ')}. Ask for a smaller frame for them.`]
        : []),
      ...warnings,
    ];
    return {
      structured: {format: input.format, files: capped.files, omitted: capped.omitted, assets, warnings},
      text: `${body}${notes.length ? `\n\n${notes.join('\n')}` : ''}`,
    };
  },
};

const getVariablesTool: ToolDefinition = {
  name: 'morfa_get_variables',
  title: 'Get variables and styles',
  description:
    'Returns a Morfa file\'s variables by collection, with each value per mode (colours as hex or rgba, an alias as {name}), and its colour, text and effect styles. For the same as code, use morfa_get_code with format "tokens".',
  inputSchema: z.object({link: linkField, fileId: fileIdField}).strict(),
  async handler(input: {link?: string; fileId?: string}, principal) {
    const {fileId} = targetOf(input);
    const file = await openFile(principal, fileId);
    const {collections, styles} = variablesAndStyles(file.doc);
    const variables = collections.reduce((sum, collection) => sum + collection.variables.length, 0);
    return {
      structured: {file: {id: file.id, name: file.name}, collections, styles},
      text: `“${file.name}”: ${variables} variable${variables === 1 ? '' : 's'} in ${collections.length} collection${collections.length === 1 ? '' : 's'}, ${styles.length} style${styles.length === 1 ? '' : 's'}.`,
    };
  },
};

/** The server's text shaper when its module is built (real widths for SVG text and vector icons), else the writers' rough one. */
export async function measurer() {
  try {
    const {serverMeasurer} = await import('../design/wasm-engine');
    return serverMeasurer();
  } catch {
    return undefined;
  }
}

export const TOOLS: readonly ToolDefinition[] = [
  listFilesTool,
  getFileTool,
  getLayersTool,
  getCodeTool,
  getVariablesTool,
];
export const toolNamed = (name: string) => TOOLS.find(tool => tool.name === name);
export {json};
