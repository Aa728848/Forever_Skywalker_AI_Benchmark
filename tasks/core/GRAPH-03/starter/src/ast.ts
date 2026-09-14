export interface AstNode {
  readonly type: string;
  readonly children?: readonly AstNode[];
}

export class DepthExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super('AST 深度超过允许上限 ' + limit);
    this.name = 'DepthExceededError';
    this.limit = limit;
  }
}

export class InvalidNodeError extends Error {
  readonly path: string;
  constructor(path: string) {
    super('AST 节点非法：' + path);
    this.name = 'InvalidNodeError';
    this.path = path;
  }
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** 校验并返回子节点；缺省 children 与空数组等价，非法结构抛出带路径的 InvalidNodeError。 */
function childrenOf(node: AstNode, path: string): readonly AstNode[] {
  const children = node.children;
  if (children === undefined) return [];
  if (!Array.isArray(children)) throw new InvalidNodeError(path + '.children');
  for (let index = 0; index < children.length; index += 1) {
    if (!isNode(children[index])) throw new InvalidNodeError(path + '.children[' + index + ']');
  }
  return children;
}

function assertRoot(root: AstNode): void {
  if (!isNode(root)) throw new InvalidNodeError('root');
}

/** 后序遍历（递归实现）。 */
function visitPostOrder(node: AstNode, path: string, visit: (node: AstNode) => void): number {
  const children = childrenOf(node, path);
  let visited = 0;
  for (let index = 0; index < children.length; index += 1) {
    visited += visitPostOrder(children[index] as AstNode, path + '.children[' + index + ']', visit);
  }
  visit(node);
  return visited + 1;
}

export function walkPostOrder(root: AstNode, visit: (node: AstNode) => void): number {
  assertRoot(root);
  return visitPostOrder(root, 'root', visit);
}

/** 前序 type 列表（递归实现）。 */
export function flattenPreOrder(root: AstNode): string[] {
  assertRoot(root);
  const types: string[] = [];
  const walk = (node: AstNode, path: string): void => {
    types.push(node.type);
    const children = childrenOf(node, path);
    for (let index = 0; index < children.length; index += 1) {
      walk(children[index] as AstNode, path + '.children[' + index + ']');
    }
  };
  walk(root, 'root');
  return types;
}

/** 最大深度（递归实现）。 */
export function maxDepth(root: AstNode, limit: number): number {
  assertRoot(root);
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit 必须是大于等于 1 的整数');
  const walk = (node: AstNode, path: string, depth: number): number => {
    let deepest = depth;
    const children = childrenOf(node, path);
    for (let index = 0; index < children.length; index += 1) {
      const child = walk(children[index] as AstNode, path + '.children[' + index + ']', depth + 1);
      if (child > deepest) deepest = child;
    }
    return deepest;
  };
  return walk(root, 'root', 1);
}

