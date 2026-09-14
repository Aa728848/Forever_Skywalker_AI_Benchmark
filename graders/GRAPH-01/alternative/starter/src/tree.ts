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

/** 替代实现：显式栈迭代 + 祖先数组，逐帧压栈。 */
interface Frame { node: TreeNode; path: string; ancestors: readonly TreeNode[]; entered: boolean }

export function walkTree(root: TreeNode, options: { maxNodes?: number } = {}): WalkResult {
  assertNode(root, 'root');
  const maxNodes = options.maxNodes ?? 10000;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new RangeError('maxNodes 必须是大于等于 1 的整数');
  const visited: string[] = [];
  const leaves: string[] = [];
  const stack: Frame[] = [{ node: root, path: 'root', ancestors: [], entered: false }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.entered) continue;
    if (frame.ancestors.includes(frame.node)) throw new InvalidTreeError(frame.path);
    if (visited.length >= maxNodes) throw new NodeLimitExceededError(maxNodes);
    visited.push(frame.node.id);
    const children = childrenOf(frame.node, frame.path);
    if (children.length === 0) leaves.push(frame.node.id);
    const ancestors = [...frame.ancestors, frame.node];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index] as TreeNode, path: frame.path + '.children[' + index + ']', ancestors, entered: false });
    }
  }
  return { visited, leaves };
}
