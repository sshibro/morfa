import type {NodeId, SceneNode, Vec} from '../types';
import {
  createBoardSection, createBoardText, createConnector, createShape, createStamp, createSticky, createTable, STAMP_SIZE, type BoardBuild, type BoardPiece, type NewId,
} from './create';
import {SECTION_COLORS, SHAPE_COLORS} from './palette';
import type {BoardShapeKind, ConnectorLine, ConnectorMagnet, StampId} from './types';

// "Board": the built-in templates (docs/board.md §Templates), FigJam's set: brainstorm, retro, kanban, mind map, flowchart,
// meeting notes, icebreaker, 5 whys, Crazy 8s, customer journey. Each is data built with the same factories the tools use
// (shared/design/board/create.ts), so a template is ordinary board objects the moment it lands: stickies type, connectors follow,
// sections fit. Pure: `buildBoardTemplate` answers the pieces, `insertBoardTemplate` puts them into a transaction at a point.

export type BoardTemplateId =
  | 'brainstorm' | 'retro' | 'kanban' | 'mind-map' | 'flowchart' | 'meeting-notes' | 'icebreaker' | 'five-whys' | 'crazy-8s' | 'journey';

export type BoardTemplateSpec = {
  id: BoardTemplateId;
  name: string;
  description: string;
  /** Search words (FigJam's English names). */
  keywords: string;
  /** The card's colour (a SECTION_COLORS id). */
  color: string;
  /** "Brainstorm", "Run a meeting", "Planning", "Diagrams" (the "+" sheet's groups). */
  group: 'ideas' | 'meetings' | 'planning' | 'diagrams';
};

export const BOARD_TEMPLATE_GROUPS: Record<BoardTemplateSpec['group'], {title: string; lead: string}> = {
  ideas: {title: 'Brainstorm together', lead: 'Find ideas, group them and pick the best.'},
  meetings: {title: 'Run a meeting', lead: 'Stand-ups, retros and icebreakers for the whole team.'},
  planning: {title: 'Plan', lead: 'Tasks, stages and the customer journey.'},
  diagrams: {title: 'Draw a diagram', lead: 'Processes and connections between ideas.'},
};

export const BOARD_TEMPLATES: readonly BoardTemplateSpec[] = [
  {id: 'brainstorm', name: 'Brainstorm', description: 'A question, ideas on stickies, voting for the best.', keywords: 'brainstorm ideas generate', color: 'yellow', group: 'ideas'},
  {id: 'crazy-8s', name: 'Crazy 8s', description: '8 minutes, 8 sketches, one minute for each.', keywords: 'crazy eights sketches drafts eight', color: 'grey', group: 'ideas'},
  {id: 'mind-map', name: 'Mind map', description: 'The main topic in the center with branches around it.', keywords: 'mind map mental map', color: 'violet', group: 'ideas'},
  {id: 'retro', name: 'Retrospective', description: 'What went well, what got in the way and what we will try.', keywords: 'retro retrospective sprint review', color: 'green', group: 'meetings'},
  {id: 'meeting-notes', name: 'Meeting notes', description: 'Agenda, notes, decisions and tasks.', keywords: 'meeting notes minutes stand-up call', color: 'blue', group: 'meetings'},
  {id: 'icebreaker', name: 'Icebreaker', description: 'Getting-to-know-you questions before work.', keywords: 'icebreaker warm-up intro', color: 'pink', group: 'meetings'},
  {id: 'kanban', name: 'Kanban', description: 'Backlog, in progress, in review, done.', keywords: 'kanban board tasks status', color: 'teal', group: 'planning'},
  {id: 'journey', name: 'Customer journey map', description: 'Stages, actions, thoughts, emotions and opportunities.', keywords: 'customer journey map cjm', color: 'orange', group: 'planning'},
  {id: 'five-whys', name: '5 whys', description: 'From symptom to root cause in five questions.', keywords: '5 whys five whys cause analysis', color: 'red', group: 'diagrams'},
  {id: 'flowchart', name: 'Flowchart', description: 'The start, steps, decisions and the end of a process.', keywords: 'flowchart diagram process algorithm', color: 'blue', group: 'diagrams'},
];

export const boardTemplate = (id: string): BoardTemplateSpec | undefined => BOARD_TEMPLATES.find(template => template.id === id);

// ── The kit ──────────────────────────────────────────────────────────────────────────────────────

const STICKY = 240;
const GAP = 24;
/** Inside a section: room for its name chip on top, and a margin around. */
const PAD = 48;
const HEAD = 72;

const sectionFill = (id: string) => (SECTION_COLORS.find(color => color.id === id) ?? SECTION_COLORS[0]).hex;
const shapeFill = (id: string) => (SHAPE_COLORS.find(color => color.id === id) ?? SHAPE_COLORS[0]).hex;

/** A built template: its pieces in creation order (`parent: ''` is the page it lands on), its top-level objects and its box. */
export type BuiltBoardTemplate = {pieces: BoardPiece[]; roots: NodeId[]; bounds: {x: number; y: number; width: number; height: number}};

class Kit {
  readonly pieces: BoardPiece[] = [];
  readonly roots: NodeId[] = [];

  constructor(readonly newId: NewId) {}

  private put(build: BoardBuild, parent: NodeId | null): NodeId {
    build.pieces.forEach((piece, i) => this.pieces.push(i === 0 ? {node: piece.node, parent: parent ?? ''} : piece));
    if (!parent) this.roots.push(build.id);
    return build.id;
  }

  section(name: string, color: string, x: number, y: number, width: number, height: number): NodeId {
    return this.put(createBoardSection(this.newId, {x, y, width, height, name, fill: sectionFill(color)}), null);
  }

  title(text: string, x = 0, y = 0): NodeId {
    return this.put(createBoardText(this.newId, {x, y, text, size: 80, handwriting: true, weight: 700}), null);
  }

  lead(text: string, x = 0, y = 104, width = 1100): NodeId {
    return this.put(createBoardText(this.newId, {x, y, text, size: 22, width, color: '#4D4D4D'}), null);
  }

  text(parent: NodeId | null, x: number, y: number, text: string, options: {size?: number; width?: number; handwriting?: boolean; weight?: number} = {}): NodeId {
    return this.put(createBoardText(this.newId, {x, y, text, size: options.size ?? 18, width: options.width, handwriting: options.handwriting, weight: options.weight}), parent);
  }

  sticky(parent: NodeId | null, x: number, y: number, text = '', color = 'yellow', wide = false): NodeId {
    return this.put(createSticky(this.newId, {x, y, text, color, wide}), parent);
  }

  /** A row of stickies, `columns` wide, from (x, y) in the parent's space. */
  stickies(parent: NodeId, x: number, y: number, texts: readonly string[], color: string, columns = texts.length): NodeId[] {
    return texts.map((text, i) => this.sticky(parent, x + (i % columns) * (STICKY + GAP), y + Math.floor(i / columns) * (STICKY + GAP), text, color));
  }

  shape(parent: NodeId | null, x: number, y: number, width: number, height: number, shape: BoardShapeKind, text: string, fill = 'blue-light', size = 20): NodeId {
    return this.put(createShape(this.newId, {x, y, width, height, shape, text, fill: shapeFill(fill), size}), parent);
  }

  connect(from: NodeId, to: NodeId, options: {line?: ConnectorLine; label?: string; from?: ConnectorMagnet; to?: ConnectorMagnet; arrow?: boolean} = {}): NodeId {
    return this.put(createConnector(this.newId, {
      start: {node: from, magnet: options.from ?? 'auto'}, end: {node: to, magnet: options.to ?? 'auto'}, line: options.line ?? 'elbow', label: options.label,
      endArrow: options.arrow ?? true,
    }), null);
  }

  table(parent: NodeId | null, x: number, y: number, cells: string[][], cellWidth = 200): NodeId {
    return this.put(createTable(this.newId, {x, y, cells, cellWidth, header: true}), parent);
  }

  stamp(parent: NodeId | null, x: number, y: number, stamp: StampId): NodeId {
    return this.put(createStamp(this.newId, {x, y, stamp}), parent);
  }
}

/** The size of a section holding a grid of stickies `columns` × `rows`. */
const gridSection = (columns: number, rows: number) => ({width: PAD * 2 + columns * STICKY + (columns - 1) * GAP, height: HEAD + PAD + rows * STICKY + (rows - 1) * GAP});

const BUILDERS: Record<BoardTemplateId, (kit: Kit) => void> = {
  brainstorm(kit) {
    kit.title('Brainstorm');
    kit.lead('Collect as many ideas as you can, group similar ones and vote for the best. No arguing or criticizing while ideas are being written.');
    const question = kit.section('Question', 'blue', 0, 200, 620, 400);
    kit.sticky(question, PAD, HEAD, 'How might we…? State the problem as one question', 'blue', true);
    const rules = kit.section('How we run it', 'grey', 0, 640, 620, 420);
    kit.text(rules, PAD, HEAD, '1. For 5–10 minutes everyone writes ideas on stickies (S), one idea per sticky.\n2. Take turns presenting the ideas and move similar ones together.\n3. Select the stickies and use "Sort stickies" to order them by color or author.\n4. Vote with stamps (E): everyone gets three votes.\n5. Mark the best ideas and agree who does what.', {size: 20, width: 524});
    const ideas = gridSection(4, 2);
    const board = kit.section('Ideas', 'yellow', 660, 200, ideas.width, ideas.height);
    kit.stickies(board, PAD, HEAD, ['Idea: …', '', '', '', '', '', '', ''], 'yellow', 4);
    const best = gridSection(3, 1);
    const top = kit.section('Best ideas', 'green', 660, 200 + ideas.height + 40, best.width, best.height);
    kit.stickies(top, PAD, HEAD, ['', '', ''], 'green');
  },

  'crazy-8s'(kit) {
    kit.title('Crazy 8s');
    kit.lead('8 minutes, 8 sketches, one minute for each. Draw with the marker (M) right in the frames, without worrying about looks. Then everyone shows theirs and we vote.');
    const task = kit.section('Task', 'blue', 0, 200, 620, 400);
    kit.sticky(task, PAD, HEAD, 'What problem are we solving? What should the user be able to do?', 'blue', true);
    const width = 400, height = 320;
    for (let i = 0; i < 8; i++) {
      const x = 660 + (i % 4) * (width + 32), y = 200 + Math.floor(i / 4) * (height + 32);
      kit.section(String(i + 1), 'grey', x, y, width, height);
    }
  },

  'mind-map'(kit) {
    kit.title('Mind map');
    kit.lead('The topic in the center, branches around it. Click the dot by a shape to add a connected one next to it; double-click to rename.');
    const cx = 640, cy = 560;
    const centre = kit.shape(null, cx - 160, cy - 90, 320, 180, 'ellipse', 'Main topic', 'violet-light', 28);
    const branches: {text: string; fill: string; side: -1 | 1; row: number; leaves: string[]}[] = [
      {text: 'Goals', fill: 'green-light', side: -1, row: -1, leaves: ['What we want to achieve', 'How we will know it worked']},
      {text: 'Audience', fill: 'blue-light', side: -1, row: 0, leaves: ['Who they are', 'What matters to them']},
      {text: 'Ideas', fill: 'yellow-light', side: -1, row: 1, leaves: ['First idea', 'Second idea']},
      {text: 'Risks', fill: 'red-light', side: 1, row: -1, leaves: ['What could go wrong', 'How we will hedge']},
      {text: 'Resources', fill: 'teal-light', side: 1, row: 0, leaves: ['People', 'Budget']},
      {text: 'Timeline', fill: 'orange-light', side: 1, row: 1, leaves: ['First step', 'Finish']},
    ];
    for (const branch of branches) {
      const bx = branch.side < 0 ? cx - 560 : cx + 340, by = cy - 50 + branch.row * 280;
      const node = kit.shape(null, bx, by, 220, 100, 'rounded', branch.text, branch.fill, 22);
      kit.connect(centre, node, {line: 'curved', arrow: false});
      branch.leaves.forEach((leaf, i) => {
        const lx = branch.side < 0 ? bx - 300 : bx + 300, ly = by - 50 + i * 120;
        const item = kit.shape(null, lx, ly, 220, 80, 'rounded', leaf, 'white', 16);
        kit.connect(node, item, {line: 'curved', arrow: false});
      });
    }
  },

  retro(kit) {
    kit.title('Retrospective');
    kit.lead('Look back at the last sprint: what helped, what got in the way and what we will try differently. First write in silence for 5 minutes, then discuss and vote.');
    const columns = gridSection(2, 3);
    const lanes: [string, string, string][] = [['What went well', 'green', 'We agreed on the design quickly'], ['What got in the way', 'red', 'We waited a long time for replies'], ['What we will try', 'blue', 'Short calls every day']];
    lanes.forEach(([name, color, example], i) => {
      const id = kit.section(name, color, i * (columns.width + 40), 200, columns.width, columns.height);
      kit.stickies(id, PAD, HEAD, [example, '', '', '', '', ''], color, 2);
    });
    const actions = kit.section('Agreements', 'violet', 0, 200 + columns.height + 40, 3 * columns.width + 80, 380);
    kit.table(actions, PAD, HEAD, [['What we do', 'Who is responsible', 'Due'], ['', '', ''], ['', '', ''], ['', '', '']], 360);
  },

  'meeting-notes'(kit) {
    kit.title('Meeting notes');
    kit.lead('Agenda, notes, decisions and tasks in one place. Invite people to the file to write together.');
    const about = kit.section('About the meeting', 'grey', 0, 200, 720, 330);
    kit.text(about, PAD, HEAD, 'Date: \nHost: \nAttendees: \nGoal of the meeting:  ', {size: 22, width: 620});
    const agenda = kit.section('Agenda', 'blue', 0, 570, 720, 460);
    kit.table(agenda, PAD, HEAD, [['Time', 'Topic', 'Led by'], ['10:00', '', ''], ['10:15', '', ''], ['10:30', '', ''], ['10:45', '', '']], 208);
    const notes = gridSection(3, 2);
    const board = kit.section('Notes', 'yellow', 760, 200, notes.width, notes.height);
    kit.stickies(board, PAD, HEAD, ['', '', '', '', '', ''], 'yellow', 3);
    const decided = kit.section('Decisions', 'green', 760, 240 + notes.height, notes.width, gridSection(3, 1).height);
    kit.stickies(decided, PAD, HEAD, ['', '', ''], 'green');
    const tasks = kit.section('Tasks', 'violet', 0, 1070, 720, 400);
    kit.table(tasks, PAD, HEAD, [['Task', 'Who', 'Due'], ['', '', ''], ['', '', ''], ['', '', '']], 208);
  },

  icebreaker(kit) {
    kit.title('Icebreaker');
    kit.lead('Get to know each other before work: everyone answers a question with a sticky and stamps (E) the answers they relate to.');
    const questions: [string, string][] = [['Where would you like to be right now?', 'pink'], ['The most useful thing you learned this month', 'orange'], ['Two truths and a lie about yourself', 'teal']];
    const size = gridSection(3, 1);
    questions.forEach(([question, color], i) => {
      const id = kit.section(question, color, 0, 200 + i * (size.height + 40), size.width, size.height);
      kit.stickies(id, PAD, HEAD, ['', '', ''], color);
      if (i === 0) kit.stamp(id, PAD + STICKY - STAMP_SIZE / 2, HEAD - STAMP_SIZE / 2, 'heart');
    });
    const who = kit.section('Who is here', 'violet', size.width + 40, 200, 620, 500);
    kit.text(who, PAD, HEAD, 'Place your own stamp: press E, then "My stamp", which carries your initials.', {size: 20, width: 524});
    kit.stamp(who, PAD, HEAD + 120, 'heart');
    kit.stamp(who, PAD + 64, HEAD + 120, 'plus-one');
  },

  kanban(kit) {
    kit.title('Kanban');
    kit.lead('Each task is a sticky. Move it from left to right as the work progresses; keep no more than three tasks per person in "In progress".');
    const lane = gridSection(1, 4);
    const lanes: [string, string, string[]][] = [
      ['Backlog', 'grey', ['Gather requirements', 'Design the home page mockup', 'Prepare the copy', '']],
      ['In progress', 'blue', ['Set up analytics', '', '', '']],
      ['In review', 'orange', ['Sign-up prototype', '', '', '']],
      ['Done', 'green', ['Call with the client', '', '', '']],
    ];
    const colors: Record<string, string> = {grey: 'white', blue: 'blue', orange: 'orange', green: 'green'};
    lanes.forEach(([name, color, tasks], i) => {
      const id = kit.section(name, color, i * (lane.width + 40), 200, lane.width, lane.height);
      tasks.forEach((task, row) => kit.sticky(id, PAD, HEAD + row * (STICKY + GAP), task, colors[color]));
    });
  },

  journey(kit) {
    kit.title('Customer journey map');
    kit.lead('How a customer goes from first contact to recommending us. Fill in every cell: what they do, think and feel, where it is hard for them and what we can do better.');
    const stages = ['Discovers', 'Chooses', 'Buys', 'Uses', 'Recommends'];
    const rows: [string, string][] = [['Actions', 'blue'], ['Thoughts', 'yellow'], ['Emotions', 'pink'], ['Pain points', 'red'], ['Opportunities', 'green']];
    const left = 260, top = 200, step = STICKY + GAP;
    stages.forEach((stage, i) => kit.shape(null, left + i * step, top, STICKY, 88, 'chevron', stage, 'blue-light', 20));
    rows.forEach(([row, color], r) => {
      const y = top + 120 + r * step;
      kit.text(null, 0, y + 96, row, {size: 28, weight: 700, width: 220, handwriting: true});
      stages.forEach((_stage, i) => kit.sticky(null, left + i * step, y, r === 0 && i === 0 ? 'Sees an ad and visits the site' : '', color));
    });
  },

  'five-whys'(kit) {
    kit.title('5 whys');
    kit.lead('Write down the problem and ask "why?" five times in a row: each answer becomes the next sticky. The last answer is the cause we work on.');
    const y = 260;
    const problem = kit.shape(null, 0, y, 300, 240, 'square', 'Problem: what happened?', 'red-light', 22);
    let previous = problem;
    for (let i = 1; i <= 5; i++) {
      const sticky = kit.sticky(null, 300 + i * 340 - 240, y, `Why ${i}?`, i % 2 ? 'yellow' : 'orange');
      kit.connect(previous, sticky, {from: 'right', to: 'left', line: 'straight'});
      previous = sticky;
    }
    const cause = kit.shape(null, 300 + 6 * 340 - 240, y, 300, 240, 'rounded', 'Root cause', 'green-light', 22);
    kit.connect(previous, cause, {from: 'right', to: 'left', line: 'straight'});
    const fix = kit.shape(null, 300 + 6 * 340 - 240, y + 340, 300, 200, 'rounded', 'What we will do to prevent it', 'blue-light', 20);
    kit.connect(cause, fix, {from: 'bottom', to: 'top'});
  },

  flowchart(kit) {
    kit.title('Flowchart');
    kit.lead('Process steps are rectangles, decisions are diamonds, the start and end are ovals. Drag from the dot by a shape to draw an arrow; double-click an arrow to add a label.');
    const x = 300;
    const start = kit.shape(null, x + 20, 220, 200, 96, 'ellipse', 'Start', 'green-light');
    const open = kit.shape(null, x, 400, 240, 120, 'square', 'User opens the site', 'blue-light', 18);
    const account = kit.shape(null, x, 600, 240, 180, 'diamond', 'Has an account?', 'yellow-light', 18);
    const signIn = kit.shape(null, x + 420, 630, 240, 120, 'square', 'Sign in', 'blue-light', 18);
    const signUp = kit.shape(null, x, 880, 240, 120, 'square', 'Sign up', 'blue-light', 18);
    const cabinet = kit.shape(null, x + 420, 880, 240, 120, 'square', 'Account', 'blue-light', 18);
    const end = kit.shape(null, x + 440, 1080, 200, 96, 'ellipse', 'End', 'red-light');
    kit.connect(start, open, {from: 'bottom', to: 'top'});
    kit.connect(open, account, {from: 'bottom', to: 'top'});
    kit.connect(account, signIn, {from: 'right', to: 'left', label: 'Yes'});
    kit.connect(account, signUp, {from: 'bottom', to: 'top', label: 'No'});
    kit.connect(signUp, cabinet, {from: 'right', to: 'left'});
    kit.connect(signIn, cabinet, {from: 'bottom', to: 'top'});
    kit.connect(cabinet, end, {from: 'bottom', to: 'top'});
  },
};

/** The template's pieces, in its own coordinates (its title at the origin). */
export function buildBoardTemplate(id: BoardTemplateId, newId: NewId): BuiltBoardTemplate {
  const kit = new Kit(newId);
  BUILDERS[id](kit);
  return {pieces: kit.pieces, roots: kit.roots, bounds: rootBounds(kit)};
}

function rootBounds(kit: Kit): BuiltBoardTemplate['bounds'] {
  const roots = new Set(kit.roots);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const {node} of kit.pieces) {
    if (!roots.has(node.id) || node.board?.kind === 'connector') continue;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return minX === Infinity ? {x: 0, y: 0, width: 0, height: 0} : {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

/** Puts a built template on a page with its top-left corner at `at` (page space), as part of the caller's transaction. Returns its
 *  top-level objects (to select and show). */
export function insertBoardTemplate(tx: {create(node: SceneNode, parentId: NodeId, index?: number): void}, built: BuiltBoardTemplate, pageId: NodeId, at: Vec): NodeId[] {
  const roots = new Set(built.roots);
  const dx = Math.round(at.x - built.bounds.x), dy = Math.round(at.y - built.bounds.y);
  for (const {node, parent} of built.pieces) {
    const placed = roots.has(node.id) && node.board?.kind !== 'connector' ? {...node, x: node.x + dx, y: node.y + dy} : node;
    tx.create(placed, parent || pageId);
  }
  return built.roots;
}
