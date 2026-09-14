export interface TreeNode {
  readonly id: string;
  readonly children?: readonly TreeNode[];
}

export interface WalkResult {
  readonly visited: readonly string[];
  readonly leaves: readonly string[];
}

export class NodeLimitExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super('节点数超过上限 ' + limit);
    this.name = 'NodeLimitExceededError';
    this.limit = limit;
  }
}

export class InvalidTreeError extends Error {
  readonly path: string;
  constructor(path: string) {
    super('非法树结构：' + path);
    this.name = 'InvalidTreeError';
    this.path = path;
  }
}

function assertNode(value: unknown, path: string): asserts value is TreeNode {
  if (typeof value !== 'object' || value === null) throw new InvalidTreeError(path);
  if (typeof (value as { id?: unknown }).id !== 'string') throw new InvalidTreeError(path);
}

function childrenOf(node: TreeNode, path: string): readonly TreeNode[] {
  const children = node.children;
  if (children === undefined) return [];
  if (!Array.isArray(children)) throw new InvalidTreeError(path + '.children');
  for (let index = 0; index < children.length; index += 1) {
    assertNode(children[index], path + '.children[' + index + ']');
  }
  return children;
}

export function walkTree(root: TreeNode, options: { maxNodes?: number } = {}): WalkResult {
  assertNode(root, 'root');
  const maxNodes = options.maxNodes ?? 10000;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new RangeError('maxNodes 必须是大于等于 1 的整数');
  const visited: string[] = [];
  const leaves: string[] = [];
  const seen = new Set<TreeNode>();
  const walk = (node: TreeNode, path: string): void => {
    // 缺陷：用全局去重代替路径检测，循环静默通过、共享节点只访问一次。
    if (seen.has(node)) return;
    seen.add(node);
    visited.push(node.id);
    const children = childrenOf(node, path);
    // 缺陷：只有显式给出空数组才算叶子，缺省 children 的节点被漏算。
    if (node.children !== undefined && children.length === 0) leaves.push(node.id);
    for (let index = 0; index < children.length; index += 1) {
      walk(children[index] as TreeNode, path + '.children[' + index + ']');
    }
  };
  walk(root, 'root');
  return { visited, leaves };
}
